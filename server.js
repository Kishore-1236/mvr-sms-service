import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import dns from 'dns';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';

// Prefer IPv4 first in Node.js DNS resolution (prevents cloud host IPv6 connection issues)
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {}

// Load environment variables (.env in current folder, or parent folder)
dotenv.config();
const parentEnvPath = path.resolve(process.cwd(), '../.env');
if (fs.existsSync(parentEnvPath)) {
  dotenv.config({ path: parentEnvPath });
}

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper: Read environment variables with fallback (handles both with/without VITE_ prefix)
function getEnv(key, fallback = '') {
  return (
    process.env[key] ||
    process.env[`VITE_${key}`] ||
    process.env[key.replace(/^VITE_/, '')] ||
    fallback
  );
}

// Helper: Get IST Date and Time
function getISTDateAndTime() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayIST = formatter.format(now); // "YYYY-MM-DD"

  const timeParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const hour = parseInt(timeParts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(timeParts.find((p) => p.type === 'minute')?.value || '0', 10);
  const nowMinutes = hour * 60 + minute;

  return { todayIST, hour, minute, nowMinutes, timeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

// Helper: Parse time string to minutes since midnight
function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const cleaned = String(timeStr).trim();
  const match12 = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(cleaned);
  if (match12) {
    let h = parseInt(match12[1], 10);
    const m = parseInt(match12[2], 10);
    const p = match12[3].toLowerCase();
    if (p === 'pm' && h < 12) h += 12;
    if (p === 'am' && h === 12) h = 0;
    return h * 60 + m;
  }
  const match24 = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(cleaned);
  if (match24) {
    return parseInt(match24[1], 10) * 60 + parseInt(match24[2], 10);
  }
  return null;
}

// Helper: Format phone number into E.164 (+91...)
function cleanPhoneNumber(phone) {
  let clean = String(phone || '').replace(/\D/g, '');
  if (clean.length === 10) clean = `+91${clean}`;
  else if (!clean.startsWith('+')) clean = `+${clean}`;
  return clean;
}

// Helper: Dispatch SMS via Android SMS Gateway
async function sendSmsViaGateway(phoneNumber, message) {
  const login = getEnv('ANDROID_SMS_LOGIN');
  const password = getEnv('ANDROID_SMS_PASSWORD');
  let rawServerUrl = getEnv('ANDROID_SMS_SERVER_URL', 'https://api.sms-gate.app');

  let base = rawServerUrl.replace(/\/+$/, '');
  let targetUrl;
  if (base.endsWith('/message')) {
    targetUrl = base;
  } else if (base.endsWith('/3rdparty/v1')) {
    targetUrl = `${base}/message`;
  } else {
    targetUrl = `${base}/3rdparty/v1/message`;
  }

  if (!login || !password) {
    throw new Error('ANDROID_SMS_LOGIN or ANDROID_SMS_PASSWORD missing in server environment variables.');
  }

  const cleanPhone = cleanPhoneNumber(phoneNumber);
  const auth = Buffer.from(`${login}:${password}`).toString('base64');

  console.log(`📤 Dispatching SMS to ${cleanPhone} via ${targetUrl}`);

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${auth}`,
    },
    body: JSON.stringify({
      phoneNumbers: [cleanPhone],
      message,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SMS Gateway HTTP ${response.status}: ${errorText}`);
  }

  const result = await response.json();
  console.log(`✅ SMS successfully dispatched to ${cleanPhone}:`, result);
  return result;
}

// Helper: Send alert SMS to property owner
async function sendOwnerAlert(alertMessage) {
  const ownerPhone = getEnv('OWNER_PHONE_NUMBER', '9505639566');
  if (!ownerPhone) return;
  try {
    await sendSmsViaGateway(ownerPhone, alertMessage);
  } catch (e) {
    console.warn('⚠️ Could not send SMS alert to owner:', e.message);
  }
}

// Supabase client instance
function getSupabase() {
  const supabaseUrl = getEnv('SUPABASE_URL');
  const supabaseKey =
    getEnv('SUPABASE_SERVICE_ROLE_KEY') ||
    getEnv('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !supabaseKey) {
    return null;
  }
  return createClient(supabaseUrl, supabaseKey);
}

// Core Automated SMS Logic (Runs in both cron endpoint and internal background scheduler)
async function executeAutomatedSmsJob() {
  const { todayIST, nowMinutes, timeStr } = getISTDateAndTime();
  const results = {
    timestamp: new Date().toISOString(),
    propertyTime: { todayIST, time: timeStr, nowMinutes },
    residency: { checkInsSent: 0, checkOutsSent: 0, errors: [] },
    grand: { checkInsSent: 0, checkOutsSent: 0, errors: [] },
  };

  const supabase = getSupabase();
  if (!supabase) {
    const msg = 'Supabase credentials missing in server environment variables.';
    console.warn(`⚠️ ${msg}`);
    return { success: false, warning: msg, results };
  }

  // -------------------------------------------------------------------------
  // 1. MVR RESIDENCY AUTOMATION
  // -------------------------------------------------------------------------
  try {
    // 1A. Residency Check-In Welcome SMS
    const { data: resCheckIns, error: resCheckInErr } = await supabase
      .from('residency_bookings')
      .select('id, guest_name, guest_phone, check_in_date, check_in_time, check_out_date, check_out_time, room_id, room_ids, welcome_sms_sent')
      .eq('booking_status', 'confirmed')
      .eq('welcome_sms_sent', false)
      .lte('check_in_date', todayIST);

    if (resCheckInErr) {
      results.residency.errors.push(resCheckInErr.message);
    } else if (resCheckIns && resCheckIns.length > 0) {
      for (const booking of resCheckIns) {
        // Stale guard: skip sending delayed welcome SMS if checkout date already passed or checkin was past
        if ((booking.check_out_date && booking.check_out_date < todayIST) || booking.check_in_date < todayIST) {
          await supabase
            .from('residency_bookings')
            .update({ welcome_sms_sent: true, welcome_sms_sent_at: new Date().toISOString() })
            .eq('id', booking.id);
          continue;
        }

        const dueAt = timeToMinutes(booking.check_in_time);
        if (booking.check_in_date === todayIST && dueAt !== null && nowMinutes < dueAt) {
          continue; // Not yet check-in time today
        }

        const roomIds = booking.room_ids && booking.room_ids.length > 0
          ? booking.room_ids
          : (booking.room_id ? [booking.room_id] : []);

        let roomNumbers = [];
        if (roomIds.length > 0) {
          const { data: rooms } = await supabase
            .from('residency_rooms')
            .select('room_number')
            .in('id', roomIds);
          if (rooms) roomNumbers = rooms.map((r) => r.room_number);
        }

        const roomsText = roomNumbers.length > 0 ? roomNumbers.join(', ') : 'Allocated at reception';
        const checkOutLine = booking.check_out_date
          ? `CHECK-OUT: ${booking.check_out_date}${booking.check_out_time ? ` at ${booking.check_out_time}` : ''}`
          : 'CHECK-OUT: 24 hours after check-in';

        const msg = `Welcome, ${booking.guest_name}!\n\nWe are delighted to welcome you to MVR Residency.\n\nROOM DETAILS\nRoom(s): ${roomsText}\n\n${checkOutLine}\n\nPhone: 08818 222545, +91 9059334335, +91 9966989848\n\nWe wish you a pleasant and comfortable stay!\n\nRegards,\nMVR Residency Team`;

        await sendSmsViaGateway(booking.guest_phone, msg);
        await sendOwnerAlert(`[MVR RESIDENCY] Check-in Alert 🏨\nGuest: ${booking.guest_name}\nPhone: +91 ${booking.guest_phone}\nRoom(s): ${roomsText}\n${checkOutLine}`);

        await supabase
          .from('residency_bookings')
          .update({
            welcome_sms_sent: true,
            welcome_sms_sent_at: new Date().toISOString(),
          })
          .eq('id', booking.id);

        results.residency.checkInsSent++;
      }
    }

    // 1B. Residency Check-Out Thank You / Exit SMS
    const { data: resCheckOuts, error: resCheckOutErr } = await supabase
      .from('residency_bookings')
      .select('id, guest_name, guest_phone, check_out_date, check_out_time, room_id, room_ids, checkout_sms_sent')
      .eq('booking_status', 'confirmed')
      .eq('checkout_sms_sent', false)
      .lte('check_out_date', todayIST);

    if (resCheckOutErr) {
      results.residency.errors.push(resCheckOutErr.message);
    } else if (resCheckOuts && resCheckOuts.length > 0) {
      for (const booking of resCheckOuts) {
        const dueAt = timeToMinutes(booking.check_out_time);
        if (booking.check_out_date === todayIST && dueAt !== null && nowMinutes < dueAt) {
          continue; // Not yet checkout time today
        }

        const msg = `Dear ${booking.guest_name},\n\nThank you for choosing MVR Residency!\n\nWe hope you had a pleasant and comfortable stay with us.\n\nWe wish you a safe and happy journey. We look forward to welcoming you back soon!\n\nMVR Residency\nTadepalligudem`;

        await sendSmsViaGateway(booking.guest_phone, msg);
        await sendOwnerAlert(`[MVR RESIDENCY] Check-out Alert 🚪\nGuest: ${booking.guest_name}\nPhone: +91 ${booking.guest_phone}\nStatus: Checked out`);

        // Mark completed and set rooms back to available
        await supabase
          .from('residency_bookings')
          .update({
            booking_status: 'completed',
            checkout_sms_sent: true,
            checkout_sms_sent_at: new Date().toISOString(),
          })
          .eq('id', booking.id);

        const roomIds = booking.room_ids && booking.room_ids.length > 0
          ? booking.room_ids
          : (booking.room_id ? [booking.room_id] : []);

        if (roomIds.length > 0) {
          await supabase
            .from('residency_rooms')
            .update({ status: 'available' })
            .in('id', roomIds);
        }

        results.residency.checkOutsSent++;
      }
    }
  } catch (err) {
    console.error('❌ Error processing Residency SMS:', err);
    results.residency.errors.push(err.message || String(err));
  }

  // -------------------------------------------------------------------------
  // 2. MVR GRAND AUTOMATION
  // -------------------------------------------------------------------------
  try {
    // 2A. Grand Check-In Welcome SMS
    const { data: grandCheckIns, error: grandCheckInErr } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_status', 'confirmed')
      .lte('check_in_date', todayIST);

    if (grandCheckInErr) {
      results.grand.errors.push(grandCheckInErr.message);
    } else if (grandCheckIns && grandCheckIns.length > 0) {
      for (const booking of grandCheckIns) {
        const reqs = booking.special_requests || '';
        if (reqs.includes('[WELCOME_SENT]')) continue;

        // Skip stale welcome SMS if checkout date already passed or checkin was past
        if ((booking.check_out_date && booking.check_out_date < todayIST) || booking.check_in_date < todayIST) {
          await supabase
            .from('bookings')
            .update({ special_requests: `${reqs} [WELCOME_SENT]`.trim() })
            .eq('id', booking.id);
          continue;
        }

        const dueAt = booking.check_in_time ? timeToMinutes(booking.check_in_time) : (12 * 60);
        if (booking.check_in_date === todayIST && dueAt !== null && nowMinutes < dueAt) continue;

        const roomIds = booking.room_ids && booking.room_ids.length > 0
          ? booking.room_ids
          : (booking.room_id ? [booking.room_id] : []);

        let roomNumbers = [];
        if (roomIds.length > 0) {
          const { data: rooms } = await supabase
            .from('rooms')
            .select('room_number')
            .in('id', roomIds);
          if (rooms) roomNumbers = rooms.map((r) => r.room_number);
        }

        const roomsText = roomNumbers.length > 0 ? roomNumbers.join(', ') : 'Allocated Room';
        const checkOutLine = booking.check_out_time ? `CHECK-OUT TIME: ${booking.check_out_time}` : 'CHECK-OUT TIME: 11:00 AM';
        const msg = `Welcome, ${booking.guest_name}!\n\nWe are delighted to welcome you to MVR Grand.\n\nROOM DETAILS\nRoom(s): ${roomsText}\n\n${checkOutLine}\n\nFor reception or assistance:\nPhone: 08818 222546, +91 9052555355, +91 9553923456\n\nWe wish you a pleasant stay!\n\nRegards,\nMVR Grand Team`;

        await sendSmsViaGateway(booking.guest_phone, msg);
        await sendOwnerAlert(`[MVR GRAND] Check-in Alert 🏨\nGuest: ${booking.guest_name}\nPhone: +91 ${booking.guest_phone}\nRoom(s): ${roomsText}\n${checkOutLine}`);

        await supabase
          .from('bookings')
          .update({ special_requests: `${reqs} [WELCOME_SENT]`.trim() })
          .eq('id', booking.id);

        results.grand.checkInsSent++;
      }
    }

    // 2B. Grand Check-Out Exit SMS
    const { data: grandCheckOuts, error: grandCheckOutErr } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_status', 'confirmed')
      .lte('check_out_date', todayIST);

    if (grandCheckOutErr) {
      results.grand.errors.push(grandCheckOutErr.message);
    } else if (grandCheckOuts && grandCheckOuts.length > 0) {
      for (const booking of grandCheckOuts) {
        const reqs = booking.special_requests || '';
        if (reqs.includes('[EXIT_SENT]')) continue;

        const dueAt = booking.check_out_time ? timeToMinutes(booking.check_out_time) : (11 * 60);
        if (booking.check_out_date === todayIST && dueAt !== null && nowMinutes < dueAt) continue;

        const msg = `Dear ${booking.guest_name},\n\nThank you for choosing MVR Grand!\n\nWe hope you had a pleasant and comfortable stay with us.\n\nWe wish you a safe and happy journey. We look forward to welcoming you back soon!\n\nMVR Grand\nTadepalligudem`;

        await sendSmsViaGateway(booking.guest_phone, msg);
        await sendOwnerAlert(`[MVR GRAND] Check-out Alert 🚪\nGuest: ${booking.guest_name}\nPhone: +91 ${booking.guest_phone}\nStatus: Checked out`);

        await supabase
          .from('bookings')
          .update({
            booking_status: 'completed',
            special_requests: `${reqs} [EXIT_SENT]`.trim(),
          })
          .eq('id', booking.id);

        const roomIds = booking.room_ids && booking.room_ids.length > 0
          ? booking.room_ids
          : (booking.room_id ? [booking.room_id] : []);

        if (roomIds.length > 0) {
          await supabase
            .from('rooms')
            .update({ status: 'available' })
            .in('id', roomIds);
        }

        results.grand.checkOutsSent++;
      }
    }
  } catch (err) {
    console.error('❌ Error processing Grand SMS:', err);
    results.grand.errors.push(err.message || String(err));
  }

  return {
    success: true,
    message: 'Automated SMS execution finished',
    results,
  };
}

// =============================================================================
// API ROUTES
// =============================================================================

// Root & Health Check
app.get(['/', '/health'], (req, res) => {
  const { todayIST, timeStr } = getISTDateAndTime();
  const hasSmsLogin = Boolean(getEnv('ANDROID_SMS_LOGIN'));
  const hasSmsPassword = Boolean(getEnv('ANDROID_SMS_PASSWORD'));
  const hasSupabaseUrl = Boolean(getEnv('SUPABASE_URL'));
  const hasSupabaseKey = Boolean(getEnv('SUPABASE_SERVICE_ROLE_KEY') || getEnv('SUPABASE_ANON_KEY'));

  res.status(200).json({
    status: 'online',
    service: 'MVR SMS & Cron Service (Render)',
    timeIST: `${todayIST} ${timeStr}`,
    uptimeSeconds: Math.floor(process.uptime()),
    configured: {
      androidSmsGateway: hasSmsLogin && hasSmsPassword,
      supabase: hasSupabaseUrl && hasSupabaseKey,
      gatewayUrl: getEnv('ANDROID_SMS_SERVER_URL', 'https://api.sms-gate.app'),
    },
  });
});

// Send SMS endpoint (Compatible with frontend fetch calls)
const handleSendSms = async (req, res) => {
  try {
    const { phoneNumber, message } = req.body || {};

    if (!phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: phoneNumber, message',
      });
    }

    const result = await sendSmsViaGateway(phoneNumber, message);

    return res.status(200).json({
      success: true,
      result,
      message: 'SMS dispatched successfully via Android SMS Gateway',
    });
  } catch (error) {
    console.error('❌ Send SMS error:', error);
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to dispatch SMS',
    });
  }
};

app.post('/api/send-android-sms', handleSendSms);
app.post('/send-sms', handleSendSms);

// Cron trigger endpoint (Can be hit manually or by external cron)
const handleCronTrigger = async (req, res) => {
  try {
    const response = await executeAutomatedSmsJob();
    return res.status(200).json(response);
  } catch (error) {
    console.error('❌ Cron execution error:', error);
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to execute cron SMS job',
    });
  }
};

app.get('/api/cron-sms', handleCronTrigger);
app.post('/api/cron-sms', handleCronTrigger);
app.get('/cron-sms', handleCronTrigger);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    availableEndpoints: [
      'GET /health',
      'POST /api/send-android-sms',
      'POST /send-sms',
      'GET /api/cron-sms',
    ],
  });
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 MVR SMS Service is listening on port ${PORT}`);
  console.log(`📱 SMS Endpoint:  POST http://localhost:${PORT}/api/send-android-sms`);
  console.log(`⏰ Cron Endpoint: GET  http://localhost:${PORT}/api/cron-sms`);
  console.log(`====================================================`);
});

// Built-in Background Scheduler (Runs every 10 minutes 24/7)
const isCronDisabled = process.env.DISABLE_INTERNAL_CRON === 'true';
if (!isCronDisabled) {
  const cronExpression = process.env.CRON_SCHEDULE || '*/10 * * * *';
  console.log(`⏱️ Setting up internal 24/7 cron scheduler (${cronExpression})...`);
  cron.schedule(cronExpression, async () => {
    try {
      console.log('⏰ [Internal Cron] Running automated check-in/out SMS check...');
      const outcome = await executeAutomatedSmsJob();
      console.log('⏰ [Internal Cron] Completed:', outcome.results);
    } catch (err) {
      console.error('⏰ [Internal Cron] Error:', err);
    }
  });
}
