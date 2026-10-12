// Clinic Appointment Booking System - Backend
// Built with Node.js core modules only (http, fs, path, crypto) - no npm install needed.
// Data is stored in JSON files inside the /data folder.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DOCTORS_FILE = path.join(DATA_DIR, 'doctors.json');
const APPOINTMENTS_FILE = path.join(DATA_DIR, 'appointments.json');

// Clinic timings: 30-minute slots, lunch break 1 PM - 2 PM
const SLOT_TIMES = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
  '14:00', '14:30', '15:00', '15:30', '16:00', '16:30'
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ---------- File helpers ----------
function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------- HTTP helpers ----------
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data === undefined ? '' : JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) req.destroy(); // reject very large bodies
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

function serveStatic(req, res, pathname) {
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'Forbidden' }); // block ../ paths

  fs.readFile(filePath, (err, content) => {
    if (err) return sendJSON(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- Date helpers ----------
function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay(); // 0 = Sunday
}

// ---------- Validation ----------
function validateAppointment(body, doctors) {
  const errors = [];
  const { patientName, phone, doctorId, date, time, reason } = body;

  if (!patientName || patientName.trim().length < 3) errors.push('Patient name must have at least 3 characters.');
  if (!/^[6-9]\d{9}$/.test(phone || '')) errors.push('Enter a valid 10-digit mobile number.');
  if (!reason || reason.trim().length < 3) errors.push('Please describe the reason for the visit.');

  const doctor = doctors.find(d => d.id === doctorId);
  if (!doctor) errors.push('Please select a valid doctor.');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    errors.push('Please select a valid date.');
  } else {
    if (date < todayISO()) errors.push('Appointments cannot be booked for a past date.');
    if (doctor && !doctor.workingDays.includes(dayOfWeek(date))) {
      errors.push(`${doctor.name} is not available on the selected day.`);
    }
  }

  if (!SLOT_TIMES.includes(time)) errors.push('Please select a valid time slot.');

  return { errors, doctor };
}

// ---------- Route handlers ----------
function getDoctors(req, res) {
  sendJSON(res, 200, readJSON(DOCTORS_FILE));
}

function getSlots(req, res, query) {
  const doctorId = query.get('doctorId');
  const date = query.get('date');
  const doctor = readJSON(DOCTORS_FILE).find(d => d.id === doctorId);
  if (!doctor || !date) return sendJSON(res, 400, { errors: ['doctorId and date are required.'] });

  if (!doctor.workingDays.includes(dayOfWeek(date))) {
    return sendJSON(res, 200, { available: false, message: `${doctor.name} does not consult on this day.`, slots: [] });
  }

  const booked = readJSON(APPOINTMENTS_FILE)
    .filter(a => a.doctorId === doctorId && a.date === date && a.status === 'Booked')
    .map(a => a.time);

  sendJSON(res, 200, { available: true, slots: SLOT_TIMES.map(time => ({ time, booked: booked.includes(time) })) });
}

function listAppointments(req, res, query) {
  const search = (query.get('search') || '').toLowerCase().trim();
  const status = query.get('status') || 'All';

  let list = readJSON(APPOINTMENTS_FILE);
  if (status !== 'All') list = list.filter(a => a.status === status);
  if (search) {
    list = list.filter(a =>
      `${a.token} ${a.patientName} ${a.phone} ${a.doctorName} ${a.specialization}`.toLowerCase().includes(search)
    );
  }

  list.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  sendJSON(res, 200, list);
}

async function createAppointment(req, res) {
  const body = await readBody(req);
  const doctors = readJSON(DOCTORS_FILE);
  const { errors, doctor } = validateAppointment(body, doctors);
  if (errors.length) return sendJSON(res, 400, { errors });

  const appointments = readJSON(APPOINTMENTS_FILE);
  const { patientName, phone, date, time, reason } = body;

  // Prevent double booking of the same doctor, date and slot
  const clash = appointments.some(
    a => a.doctorId === doctor.id && a.date === date && a.time === time && a.status === 'Booked'
  );
  if (clash) return sendJSON(res, 409, { errors: ['This slot is already booked. Please choose another time.'] });

  const lastToken = appointments.reduce((max, a) => Math.max(max, Number(a.token.split('-')[1])), 1000);

  const appointment = {
    id: crypto.randomUUID(),
    token: 'APT-' + (lastToken + 1),
    patientName: patientName.trim(),
    phone,
    doctorId: doctor.id,
    doctorName: doctor.name,
    specialization: doctor.specialization,
    room: doctor.room,
    date,
    time,
    reason: reason.trim(),
    status: 'Booked',
    createdAt: new Date().toISOString()
  };

  appointments.push(appointment);
  writeJSON(APPOINTMENTS_FILE, appointments);
  sendJSON(res, 201, appointment);
}

async function updateStatus(req, res, id) {
  const { status } = await readBody(req);
  if (!['Completed', 'Cancelled'].includes(status)) {
    return sendJSON(res, 400, { errors: ['Status must be Completed or Cancelled.'] });
  }

  const appointments = readJSON(APPOINTMENTS_FILE);
  const appt = appointments.find(a => a.id === id);
  if (!appt) return sendJSON(res, 404, { errors: ['Appointment not found.'] });
  if (appt.status !== 'Booked') {
    return sendJSON(res, 400, { errors: [`Appointment is already ${appt.status.toLowerCase()}.`] });
  }

  appt.status = status;
  writeJSON(APPOINTMENTS_FILE, appointments);
  sendJSON(res, 200, appt);
}

function deleteAppointment(req, res, id) {
  const appointments = readJSON(APPOINTMENTS_FILE);
  const remaining = appointments.filter(a => a.id !== id);
  if (remaining.length === appointments.length) return sendJSON(res, 404, { errors: ['Appointment not found.'] });
  writeJSON(APPOINTMENTS_FILE, remaining);
  sendJSON(res, 204);
}

function getStats(req, res) {
  const list = readJSON(APPOINTMENTS_FILE);
  const today = todayISO();
  sendJSON(res, 200, {
    total: list.length,
    today: list.filter(a => a.date === today && a.status === 'Booked').length,
    upcoming: list.filter(a => a.date >= today && a.status === 'Booked').length,
    completed: list.filter(a => a.status === 'Completed').length,
    cancelled: list.filter(a => a.status === 'Cancelled').length,
    doctors: readJSON(DOCTORS_FILE).length
  });
}

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = url;
  const method = req.method;

  try {
    if (method === 'GET' && pathname === '/api/doctors') return getDoctors(req, res);
    if (method === 'GET' && pathname === '/api/slots') return getSlots(req, res, searchParams);
    if (method === 'GET' && pathname === '/api/stats') return getStats(req, res);
    if (method === 'GET' && pathname === '/api/appointments') return listAppointments(req, res, searchParams);
    if (method === 'POST' && pathname === '/api/appointments') return await createAppointment(req, res);

    const statusMatch = pathname.match(/^\/api\/appointments\/([\w-]+)\/status$/);
    if (method === 'PATCH' && statusMatch) return await updateStatus(req, res, statusMatch[1]);

    const idMatch = pathname.match(/^\/api\/appointments\/([\w-]+)$/);
    if (method === 'DELETE' && idMatch) return deleteAppointment(req, res, idMatch[1]);

    if (pathname.startsWith('/api/')) return sendJSON(res, 404, { errors: ['API route not found.'] });
    if (method === 'GET') return serveStatic(req, res, pathname);

    sendJSON(res, 405, { errors: ['Method not allowed.'] });
  } catch (err) {
    sendJSON(res, 400, { errors: [err.message] });
  }
});

server.listen(PORT, () => {
  console.log(`Clinic Appointment Booking System running at http://localhost:${PORT}`);
});
