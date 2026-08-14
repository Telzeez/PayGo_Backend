import crypto from 'crypto';
import axios from 'axios';

const SECRET = process.env.PAYSTACK_SECRET_KEY || 'sk_test_89821baac945f63f2e385317afa688602a5f3683';
const URL = 'http://localhost:5000/api/webhook/paystack';
const REFERENCE = 't32a3q1hin';

const payload = {
  event: 'charge.success',
  data: {
    reference: REFERENCE,
    amount: 100000, // example 1000 NGN in kobo
    customer: {
      email: 'test@example.com'
    },
    metadata: {
      deviceId: 'DEVICE-001'
    }
  }
};

const payloadString = JSON.stringify(payload);
const hash = crypto.createHmac('sha512', SECRET).update(payloadString).digest('hex');

console.log('Sending mock webhook...');

axios.post(URL, payloadString, {
  headers: {
    'x-paystack-signature': hash,
    'Content-Type': 'application/json'
  }
}).then(res => {
  console.log('Success:', res.data);
}).catch(err => {
  console.error('Error:', err.response ? err.response.data : err.message);
});
