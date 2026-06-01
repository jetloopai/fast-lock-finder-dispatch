'use strict';

const Airtable = require('airtable');

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
  .base(process.env.AIRTABLE_BASE_ID);

const TABLES = {
  CUSTOMERS: 'Customers',
  JOBS: 'Jobs',
  TECHNICIANS: 'Technicians',
};

const STATUS_PHRASES = {
  'Pending':   'Your job is pending and will be assigned shortly.',
  'Assigned':  'A technician has been assigned to your job.',
  'En Route':  'Your technician is on the way.',
  'Arrived':   'Your technician has arrived at the location.',
  'Completed': 'Your job has been marked as completed.',
};

async function createCustomer({ name, phone, address, vehicle }) {
  const record = await base(TABLES.CUSTOMERS).create({
    'Name':    name,
    'Phone':   phone,
    'Address': address,
    'Vehicle': vehicle,
  });
  return record.id;
}

async function createJob({ customerId, callerPhone, serviceType, notes }) {
  const record = await base(TABLES.JOBS).create({
    'Customer':     [customerId],
    'Caller Phone': callerPhone,
    'Service Type': serviceType,
    'Status':       'Pending',
    'Notes':        notes || '',
    'Created Date': new Date().toISOString(),
  });
  return { recordId: record.id, jobNumber: record.fields['Job ID'] };
}

async function updateJob(recordId, fields) {
  await base(TABLES.JOBS).update(recordId, fields);
}

async function findJobByNumber(jobNumber) {
  const n = parseInt(jobNumber, 10);
  if (isNaN(n)) return null;
  const records = await base(TABLES.JOBS)
    .select({ filterByFormula: `{Job ID} = ${n}`, maxRecords: 1 })
    .firstPage();
  return records[0] || null;
}

async function findJobByPhoneLast4(last4) {
  const records = await base(TABLES.JOBS)
    .select({
      filterByFormula: `RIGHT({Caller Phone}, 4) = "${last4}"`,
      sort: [{ field: 'Created Date', direction: 'desc' }],
      maxRecords: 1,
    })
    .firstPage();
  return records[0] || null;
}

function getStatusPhrase(status) {
  return STATUS_PHRASES[status] || `Your job status is ${status}.`;
}

module.exports = {
  createCustomer,
  createJob,
  updateJob,
  findJobByNumber,
  findJobByPhoneLast4,
  getStatusPhrase,
};
