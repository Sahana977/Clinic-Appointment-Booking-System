// Clinic Appointment Booking System - Frontend logic
// Talks to the Express REST API using fetch().

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const form = document.getElementById('bookingForm');
const doctorSelect = document.getElementById('doctorId');
const dateInput = document.getElementById('date');
const slotsBox = document.getElementById('slots');
const formMessage = document.getElementById('formMessage');
const rows = document.getElementById('appointmentRows');
const emptyState = document.getElementById('emptyState');
const searchInput = document.getElementById('search');
const statusFilter = document.getElementById('statusFilter');

let doctors = [];
let selectedTime = '';

// ---------- Helpers ----------
function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatTime(t) {
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}

// Create an element with safe text content (prevents HTML injection)
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error((data.errors || [data.error]).join(' '));
  return data;
}

// ---------- Doctors ----------
async function loadDoctors() {
  doctors = await api('/api/doctors');
  doctorSelect.innerHTML = '';
  doctorSelect.append(new Option('-- Select a doctor --', ''));
  doctors.forEach(d => doctorSelect.append(new Option(`${d.name} (${d.specialization})`, d.id)));
}

function showDoctorDays() {
  const doc = doctors.find(d => d.id === doctorSelect.value);
  document.getElementById('doctorDays').textContent = doc
    ? `Consults on: ${doc.workingDays.map(n => DAY_NAMES[n]).join(', ')} · Room ${doc.room}`
    : '';
}

// ---------- Slots ----------
async function loadSlots() {
  selectedTime = '';
  slotsBox.innerHTML = '';
  if (!doctorSelect.value || !dateInput.value) {
    slotsBox.append(el('p', 'Select a doctor and date to see slots.', 'hint'));
    return;
  }

  const data = await api(`/api/slots?doctorId=${doctorSelect.value}&date=${dateInput.value}`);
  if (!data.available) {
    slotsBox.append(el('p', data.message, 'hint'));
    return;
  }

  data.slots.forEach(slot => {
    const btn = el('button', formatTime(slot.time), 'slot');
    btn.type = 'button';
    btn.disabled = slot.booked;
    btn.title = slot.booked ? 'Already booked' : 'Available';
    btn.addEventListener('click', () => {
      slotsBox.querySelectorAll('.slot').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedTime = slot.time;
    });
    slotsBox.append(btn);
  });
}

// ---------- Booking ----------
form.addEventListener('submit', async e => {
  e.preventDefault();
  formMessage.className = 'message';
  formMessage.textContent = '';

  const payload = {
    patientName: document.getElementById('patientName').value.trim(),
    phone: document.getElementById('phone').value.trim(),
    doctorId: doctorSelect.value,
    date: dateInput.value,
    time: selectedTime,
    reason: document.getElementById('reason').value.trim()
  };

  try {
    const appt = await api('/api/appointments', { method: 'POST', body: JSON.stringify(payload) });
    formMessage.classList.add('success');
    formMessage.textContent = `Booked! Token ${appt.token} with ${appt.doctorName} on ${formatDate(appt.date)} at ${formatTime(appt.time)}.`;
    form.reset();
    dateInput.value = '';
    showDoctorDays();
    await loadSlots();
    await refresh();
  } catch (err) {
    formMessage.classList.add('error');
    formMessage.textContent = err.message;
  }
});

// ---------- Appointment list ----------
async function renderAppointments() {
  const params = new URLSearchParams({ search: searchInput.value, status: statusFilter.value });
  const list = await api(`/api/appointments?${params}`);

  rows.innerHTML = '';
  emptyState.hidden = list.length > 0;

  list.forEach(a => {
    const tr = document.createElement('tr');

    const tokenTd = el('td');
    tokenTd.append(el('strong', a.token));

    const patientTd = el('td', a.patientName);
    patientTd.append(el('small', `${a.phone} · ${a.reason}`));

    const doctorTd = el('td', a.doctorName);
    doctorTd.append(el('small', `${a.specialization} · Room ${a.room}`));

    const whenTd = el('td', formatDate(a.date));
    whenTd.append(el('small', formatTime(a.time)));

    const statusTd = el('td');
    statusTd.append(el('span', a.status, `badge ${a.status}`));

    const actionsTd = el('td');
    if (a.status === 'Booked') {
      actionsTd.append(actionButton('Complete', 'done', () => updateStatus(a.id, 'Completed')));
      actionsTd.append(actionButton('Cancel', 'cancel', () => updateStatus(a.id, 'Cancelled')));
    } else {
      actionsTd.append(actionButton('Delete', 'delete', () => deleteAppointment(a.id)));
    }

    tr.append(tokenTd, patientTd, doctorTd, whenTd, statusTd, actionsTd);
    rows.append(tr);
  });
}

function actionButton(label, kind, handler) {
  const b = el('button', label, `btn small ${kind}`);
  b.addEventListener('click', handler);
  return b;
}

async function updateStatus(id, status) {
  if (status === 'Cancelled' && !confirm('Cancel this appointment?')) return;
  try {
    await api(`/api/appointments/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    toast(`Appointment marked as ${status}.`);
    await refresh();
    await loadSlots();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteAppointment(id) {
  if (!confirm('Delete this record permanently?')) return;
  await api(`/api/appointments/${id}`, { method: 'DELETE' });
  toast('Record deleted.');
  await refresh();
}

// ---------- Dashboard ----------
async function renderStats() {
  const s = await api('/api/stats');
  document.getElementById('statToday').textContent = s.today;
  document.getElementById('statUpcoming').textContent = s.upcoming;
  document.getElementById('statCompleted').textContent = s.completed;
  document.getElementById('statCancelled').textContent = s.cancelled;
  document.getElementById('statDoctors').textContent = s.doctors;
}

async function refresh() {
  await Promise.all([renderAppointments(), renderStats()]);
}

// ---------- Init ----------
doctorSelect.addEventListener('change', () => { showDoctorDays(); loadSlots(); });
dateInput.addEventListener('change', loadSlots);
searchInput.addEventListener('input', renderAppointments);
statusFilter.addEventListener('change', renderAppointments);

(async function init() {
  dateInput.min = todayISO();
  document.getElementById('todayLabel').textContent =
    new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  await loadDoctors();
  await refresh();
})();
