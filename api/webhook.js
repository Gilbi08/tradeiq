import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_details?.email || session.customer_email;

    if (!customerEmail) {
      console.error('No email found in session');
      return res.status(400).json({ error: 'No email' });
    }

    // Find user in Supabase by email and mark as paid
    const { data: users, error: fetchError } = await supabase.auth.admin.listUsers();

    if (fetchError) {
      console.error('Error fetching users:', fetchError);
      return res.status(500).json({ error: 'Could not fetch users' });
    }

    const user = users.users.find(u => u.email === customerEmail);

    if (user) {
      // Update user metadata to mark as paid
      const { error: updateError } = await supabase.auth.admin.updateUserById(
        user.id,
        {
          user_metadata: {
            ...user.user_metadata,
            paid: true,
            paid_at: new Date().toISOString(),
            stripe_customer_id: session.customer,
            stripe_session_id: session.id,
          }
        }
      );

      if (updateError) {
        console.error('Error updating user:', updateError);
        return res.status(500).json({ error: 'Could not update user' });
      }

      console.log(`✅ User ${customerEmail} marked as paid`);
    } else {
      // User not registered yet – save payment for later
      const { error: insertError } = await supabase
        .from('pending_payments')
        .insert({
          email: customerEmail,
          stripe_session_id: session.id,
          stripe_customer_id: session.customer,
          paid_at: new Date().toISOString(),
        });

      if (insertError) {
        console.error('Error saving pending payment:', insertError);
      }

      console.log(`💾 Saved pending payment for ${customerEmail}`);
    }
  }

  return res.status(200).json({ received: true });
}
