import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

// One endpoint, three roles (Vercel Hobby caps us at 12 functions):
//  - POST with X-Twilio-Signature  → inbound SMS webhook from Twilio
//  - GET  with Bearer token        → recent messages for the inbox UI
//  - POST with Bearer token        → send an SMS to a contact
//  - PUT  with Bearer token        → mark a thread read

const ALLOWED_ORIGIN = 'https://call-buddy-omega.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    return res.status(500).json({ error: 'Supabase not configured' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  /* ── Twilio inbound SMS webhook ─────────────────────────────────────── */
  const twilioSignature = req.headers['x-twilio-signature'];
  if (req.method === 'POST' && twilioSignature) {
    if (!process.env.TWILIO_AUTH_TOKEN)
      return res.status(500).send('<Response></Response>');

    const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL
      ? process.env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, '')
      : `https://${req.headers.host}`;
    const valid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      twilioSignature,
      `${baseUrl}${req.url}`,
      req.body || {}
    );
    if (!valid) {
      console.error('SMS sig validation failed');
      return res.status(403).send('<Response></Response>');
    }

    res.setHeader('Content-Type', 'text/xml');
    const { From, To, Body, MessageSid } = req.body;
    if (!From || !To) return res.status(200).send('<Response></Response>');

    try {
      // Which user owns the number that received this text?
      const { data: owner } = await supabase
        .from('profiles')
        .select('id')
        .eq('twilio_phone_number', To)
        .single();

      if (owner?.id) {
        // Link (or create) the contact for this sender
        let contactId = null;
        const { data: existing } = await supabase
          .from('contacts')
          .select('id')
          .eq('user_id', owner.id)
          .eq('phone', From)
          .maybeSingle();
        if (existing?.id) {
          contactId = existing.id;
          await supabase.from('contacts')
            .update({ last_called: new Date().toISOString() })
            .eq('id', contactId);
        } else {
          const { data: created } = await supabase
            .from('contacts')
            .insert({ user_id: owner.id, phone: From, name: 'Unknown', stage: 'new', heat_score: 'Warm' })
            .select('id')
            .single();
          contactId = created?.id || null;
        }

        await supabase.from('messages').insert({
          user_id: owner.id,
          contact_id: contactId,
          phone: From,
          direction: 'inbound',
          body: Body || '',
          twilio_sid: MessageSid || null,
          read: false
        });
      } else {
        console.warn('Inbound SMS to unowned number:', To);
      }
    } catch (e) {
      console.error('Inbound SMS error:', e);
    }
    // Empty TwiML = no auto-reply
    return res.status(200).send('<Response></Response>');
  }

  /* ── Frontend inbox API (Bearer auth) ───────────────────────────────── */
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let user;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Unauthorized' });
    user = data.user;
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (req.method === 'GET') {
      const { phone, limit = 300 } = req.query;
      let query = supabase
        .from('messages')
        .select('*, contacts(id, name, company)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(parseInt(limit));
      if (phone) query = query.eq('phone', phone);
      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const { to, body, contact_id } = req.body || {};
      if (!to || !body) return res.status(400).json({ error: 'to and body required' });
      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN)
        return res.status(500).json({ error: 'Twilio not configured' });

      const { data: profile } = await supabase
        .from('profiles')
        .select('twilio_phone_number')
        .eq('id', user.id)
        .single();
      const fromPhone = profile?.twilio_phone_number || process.env.TWILIO_PHONE_NUMBER;
      const msgServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
      if (!fromPhone && !msgServiceSid) return res.status(500).json({ error: 'No outbound phone number on your account' });

      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      // Prefer the A2P 10DLC messaging service (it applies the registered
      // campaign and picks a sender from its pool); fall back to the bare number.
      const sendOpts = msgServiceSid
        ? { body, to, messagingServiceSid: msgServiceSid }
        : { body, to, from: fromPhone };

      let sms;
      try {
        sms = await client.messages.create(sendOpts);
      } catch (twErr) {
        // Surface WHY it failed instead of a generic 500, so the inbox can tell
        // the user the real reason (e.g. not yet A2P-registered, or opted out).
        const code = twErr && twErr.code;
        console.error('Twilio send failed:', code, twErr && twErr.message);
        const reason =
          code === 30034 ? 'This number isn’t approved for A2P 10DLC texting yet, so carriers blocked the message.' :
          code === 21610 ? 'This contact replied STOP and is unsubscribed — you can’t text them unless they text START first.' :
          code === 21408 || code === 21606 ? 'This number can’t send SMS (not SMS-enabled or not owned by your account).' :
          (twErr && twErr.message) || 'Message could not be sent.';
        return res.status(502).json({ error: reason, twilio_code: code || null });
      }

      const { data: saved, error } = await supabase.from('messages').insert({
        user_id: user.id,
        contact_id: contact_id || null,
        phone: to,
        direction: 'outbound',
        body,
        twilio_sid: sms.sid,
        read: true
      }).select().single();
      if (error) throw error;
      return res.status(201).json(saved);
    }

    if (req.method === 'PUT') {
      const { phone } = req.body || {};
      if (!phone) return res.status(400).json({ error: 'phone required' });
      const { error } = await supabase.from('messages')
        .update({ read: true })
        .eq('user_id', user.id)
        .eq('phone', phone)
        .eq('direction', 'inbound')
        .eq('read', false);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Messages API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
