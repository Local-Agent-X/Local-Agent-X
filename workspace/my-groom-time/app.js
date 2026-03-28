const STORAGE_KEY = 'my-groom-time-v1';

const state = loadState();

const els = {
  navBtns: [...document.querySelectorAll('.nav-btn')],
  views: [...document.querySelectorAll('.view')],
  kpiCards: document.getElementById('kpiCards'),
  todayRoute: document.getElementById('todayRoute'),
  appointmentForm: document.getElementById('appointmentForm'),
  customerForm: document.getElementById('customerForm'),
  serviceForm: document.getElementById('serviceForm'),
  invoiceForm: document.getElementById('invoiceForm'),
  appointmentCustomerSelect: document.getElementById('appointmentCustomerSelect'),
  appointmentPetSelect: document.getElementById('appointmentPetSelect'),
  appointmentServiceSelect: document.getElementById('appointmentServiceSelect'),
  invoiceAppointmentSelect: document.getElementById('invoiceAppointmentSelect'),
  appointmentsList: document.getElementById('appointmentsList'),
  customersList: document.getElementById('customersList'),
  servicesList: document.getElementById('servicesList'),
  invoicesList: document.getElementById('invoicesList'),
  seedDemoBtn: document.getElementById('seedDemoBtn'),
  clearBtn: document.getElementById('clearBtn'),
};

bindEvents();
renderAll();

function bindEvents() {
  els.navBtns.forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  els.customerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const customerId = uid('cust');
    const petId = uid('pet');

    const customer = {
      id: customerId,
      name: String(fd.get('customerName')).trim(),
      phone: String(fd.get('phone')).trim(),
      email: String(fd.get('email') || '').trim(),
      pets: [
        {
          id: petId,
          name: String(fd.get('petName')).trim(),
          breed: String(fd.get('breed') || '').trim(),
          weight: Number(fd.get('weight') || 0),
          behaviorNotes: String(fd.get('behaviorNotes') || '').trim(),
        },
      ],
      createdAt: new Date().toISOString(),
    };

    state.customers.push(customer);
    persist();
    e.target.reset();
    renderAll();
  });

  els.serviceForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    state.services.push({
      id: uid('svc'),
      name: String(fd.get('name')).trim(),
      duration: Number(fd.get('duration')),
      price: Number(fd.get('price')),
      createdAt: new Date().toISOString(),
    });
    persist();
    e.target.reset();
    renderAll();
  });

  els.appointmentCustomerSelect.addEventListener('change', () => {
    populatePetSelect(els.appointmentCustomerSelect.value);
  });

  els.appointmentForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    state.appointments.push({
      id: uid('apt'),
      date: String(fd.get('date')),
      time: String(fd.get('time')),
      customerId: String(fd.get('customerId')),
      petId: String(fd.get('petId')),
      address: String(fd.get('address')).trim(),
      serviceId: String(fd.get('serviceId')),
      status: String(fd.get('status')),
      notes: String(fd.get('notes') || '').trim(),
      createdAt: new Date().toISOString(),
    });
    persist();
    e.target.reset();
    renderAll();
  });

  els.invoiceForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    state.invoices.push({
      id: uid('inv'),
      appointmentId: String(fd.get('appointmentId')),
      amountPaid: Number(fd.get('amountPaid')),
      paymentMethod: String(fd.get('paymentMethod')),
      notes: String(fd.get('notes') || '').trim(),
      createdAt: new Date().toISOString(),
    });
    persist();
    e.target.reset();
    renderAll();
  });

  els.seedDemoBtn.addEventListener('click', seedDemoData);
  els.clearBtn.addEventListener('click', () => {
    if (!confirm('Delete all local My Groom Time data?')) return;
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });
}

function setView(viewId) {
  els.navBtns.forEach((b) => b.classList.toggle('active', b.dataset.view === viewId));
  els.views.forEach((v) => v.classList.toggle('active', v.id === viewId));
}

function renderAll() {
  renderKpis();
  renderCustomers();
  renderServices();
  renderAppointments();
  renderInvoices();
  populateSelectors();
}

function renderKpis() {
  const month = new Date().toISOString().slice(0, 7);
  const monthApts = state.appointments.filter((a) => a.date.startsWith(month));
  const revenue = state.invoices
    .filter((i) => {
      const a = state.appointments.find((x) => x.id === i.appointmentId);
      return a && a.date.startsWith(month);
    })
    .reduce((sum, i) => sum + i.amountPaid, 0);

  const today = new Date().toISOString().slice(0, 10);
  const todayApts = state.appointments
    .filter((a) => a.date === today)
    .sort((a, b) => a.time.localeCompare(b.time));

  const cards = [
    ['Customers', state.customers.length],
    ['Active Pets', state.customers.reduce((n, c) => n + c.pets.length, 0)],
    ['Appointments This Month', monthApts.length],
    ['Revenue This Month', `$${revenue.toFixed(2)}`],
  ];

  els.kpiCards.innerHTML = cards
    .map(([k, v]) => `<div class="card"><h3>${k}</h3><div class="value">${v}</div></div>`)
    .join('');

  if (!todayApts.length) {
    els.todayRoute.innerHTML = `<p class="muted">No appointments scheduled for today.</p>`;
    return;
  }

  els.todayRoute.innerHTML = table([
    ['Time', 'Customer', 'Pet', 'Service', 'Status', 'Address'],
    ...todayApts.map((a) => [
      a.time,
      customerName(a.customerId),
      petName(a.customerId, a.petId),
      serviceName(a.serviceId),
      `<span class="badge">${a.status}</span>`,
      a.address,
    ]),
  ]);
}

function renderCustomers() {
  if (!state.customers.length) {
    els.customersList.innerHTML = `<p class="muted">No customers yet.</p>`;
    return;
  }

  const rows = state.customers.map((c) => [
    c.name,
    c.phone,
    c.email || '-',
    c.pets.map((p) => `${p.name} (${p.breed || 'Unknown'})`).join(', '),
  ]);
  els.customersList.innerHTML = table([['Customer', 'Phone', 'Email', 'Pets'], ...rows]);
}

function renderServices() {
  if (!state.services.length) {
    els.servicesList.innerHTML = `<p class="muted">No services yet.</p>`;
    return;
  }
  const rows = state.services.map((s) => [s.name, `${s.duration} mins`, `$${s.price.toFixed(2)}`]);
  els.servicesList.innerHTML = table([['Service', 'Duration', 'Price'], ...rows]);
}

function renderAppointments() {
  if (!state.appointments.length) {
    els.appointmentsList.innerHTML = `<p class="muted">No appointments yet.</p>`;
    return;
  }

  const sorted = [...state.appointments].sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
  const rows = sorted.map((a) => [
    `${a.date} ${a.time}`,
    customerName(a.customerId),
    petName(a.customerId, a.petId),
    serviceName(a.serviceId),
    `<span class="badge">${a.status}</span>`,
    a.address,
  ]);
  els.appointmentsList.innerHTML = table([['When', 'Customer', 'Pet', 'Service', 'Status', 'Address'], ...rows]);
}

function renderInvoices() {
  if (!state.invoices.length) {
    els.invoicesList.innerHTML = `<p class="muted">No invoices yet.</p>`;
    return;
  }
  const rows = state.invoices
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((i) => {
      const apt = state.appointments.find((a) => a.id === i.appointmentId);
      return [
        i.id,
        apt ? `${apt.date} ${apt.time}` : 'Unknown',
        apt ? customerName(apt.customerId) : '-',
        `$${i.amountPaid.toFixed(2)}`,
        i.paymentMethod,
        i.notes || '-',
      ];
    });
  els.invoicesList.innerHTML = table([['Invoice', 'Appointment', 'Customer', 'Amount', 'Method', 'Notes'], ...rows]);
}

function populateSelectors() {
  const customerOpts = state.customers
    .map((c) => `<option value="${c.id}">${c.name}</option>`)
    .join('');
  els.appointmentCustomerSelect.innerHTML = customerOpts || '<option value="">No customers</option>';

  const serviceOpts = state.services
    .map((s) => `<option value="${s.id}">${s.name} ($${s.price.toFixed(2)})</option>`)
    .join('');
  els.appointmentServiceSelect.innerHTML = serviceOpts || '<option value="">No services</option>';

  const doneAppointments = state.appointments.filter((a) => a.status === 'Done');
  const invoiceOpts = doneAppointments
    .map((a) => `<option value="${a.id}">${a.date} ${a.time} — ${customerName(a.customerId)} / ${petName(a.customerId, a.petId)}</option>`)
    .join('');
  els.invoiceAppointmentSelect.innerHTML = invoiceOpts || '<option value="">No completed appointments</option>';

  if (state.customers[0]) {
    populatePetSelect(state.customers[0].id);
  } else {
    els.appointmentPetSelect.innerHTML = '<option value="">No pets</option>';
  }
}

function populatePetSelect(customerId) {
  const customer = state.customers.find((c) => c.id === customerId);
  if (!customer) {
    els.appointmentPetSelect.innerHTML = '<option value="">No pets</option>';
    return;
  }

  els.appointmentPetSelect.innerHTML = customer.pets
    .map((p) => `<option value="${p.id}">${p.name} (${p.breed || 'Unknown'})</option>`)
    .join('');
}

function customerName(customerId) {
  return state.customers.find((c) => c.id === customerId)?.name || 'Unknown';
}

function petName(customerId, petId) {
  return state.customers.find((c) => c.id === customerId)?.pets.find((p) => p.id === petId)?.name || 'Unknown';
}

function serviceName(serviceId) {
  return state.services.find((s) => s.id === serviceId)?.name || 'Unknown';
}

function table(rows) {
  const [head, ...body] = rows;
  return `
    <table class="table">
      <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>
        ${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>
  `;
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    return { ...freshState(), ...JSON.parse(raw) };
  } catch {
    return freshState();
  }
}

function freshState() {
  return {
    customers: [],
    services: [],
    appointments: [],
    invoices: [],
  };
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function seedDemoData() {
  if (state.customers.length || state.services.length || state.appointments.length || state.invoices.length) {
    if (!confirm('Demo data will be added on top of existing data. Continue?')) return;
  }

  const cust1 = { id: uid('cust'), name: 'Sarah Thompson', phone: '469-555-1022', email: 'sarah@example.com', pets: [{ id: uid('pet'), name: 'Luna', breed: 'Goldendoodle', weight: 52, behaviorNotes: 'Anxious with dryers' }], createdAt: new Date().toISOString() };
  const cust2 = { id: uid('cust'), name: 'Mike Rodriguez', phone: '214-555-8891', email: 'mike@example.com', pets: [{ id: uid('pet'), name: 'Rocky', breed: 'French Bulldog', weight: 28, behaviorNotes: 'Sensitive paws' }], createdAt: new Date().toISOString() };
  state.customers.push(cust1, cust2);

  const svc1 = { id: uid('svc'), name: 'Full Groom', duration: 90, price: 95, createdAt: new Date().toISOString() };
  const svc2 = { id: uid('svc'), name: 'Bath + Blowout', duration: 60, price: 65, createdAt: new Date().toISOString() };
  state.services.push(svc1, svc2);

  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const apt1 = { id: uid('apt'), date: dateStr, time: '09:00', customerId: cust1.id, petId: cust1.pets[0].id, address: '1201 Lake View Dr', serviceId: svc1.id, status: 'Scheduled', notes: '', createdAt: new Date().toISOString() };
  const apt2 = { id: uid('apt'), date: dateStr, time: '11:30', customerId: cust2.id, petId: cust2.pets[0].id, address: '902 Oak St', serviceId: svc2.id, status: 'Done', notes: 'Nail trim included', createdAt: new Date().toISOString() };
  state.appointments.push(apt1, apt2);

  state.invoices.push({ id: uid('inv'), appointmentId: apt2.id, amountPaid: 65, paymentMethod: 'Card', notes: 'Tip included', createdAt: new Date().toISOString() });

  persist();
  renderAll();
}
