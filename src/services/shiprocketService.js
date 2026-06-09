const BASE_URL = 'https://apiv2.shiprocket.in/v1/external';

let _token = null;
let _tokenExpiry = 0;

/* ── Auth: get token, cache it for 23 hours ── */
async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:    process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD,
    }),
  });
  const data = await res.json();
  if (!data.token) throw new Error('Shiprocket auth failed: ' + JSON.stringify(data));

  _token       = data.token;
  _tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23 hours
  return _token;
}

async function headers() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${await getToken()}`,
  };
}

/* ── Create a Shiprocket order after customer places order ── */
export async function createShiprocketOrder({
  orderId, orderNumber, orderDate,
  customerName, customerEmail, customerPhone,
  address, city, pincode, state,
  productName, quantity, price,
  weight = 0.5,  // kg — update per product if needed
}) {
  const body = {
    order_id:          String(orderNumber),
    order_date:        orderDate,  // "YYYY-MM-DD HH:mm"
    pickup_location:   'Primary',  // must match your Shiprocket warehouse name
    billing_customer_name:  customerName,
    billing_address:        address,
    billing_city:           city,
    billing_pincode:        String(pincode),
    billing_state:          state,
    billing_country:        'India',
    billing_email:          customerEmail,
    billing_phone:          String(customerPhone),
    shipping_is_billing:    true,
    order_items: [
      {
        name:         productName,
        sku:          `SKU-${orderId}`,
        units:        quantity,
        selling_price: price,
      },
    ],
    payment_method: 'Prepaid',   // always Prepaid for online orders
    sub_total:      price * quantity,
    length:         10,
    breadth:        10,
    height:         10,
    weight,
  };

  const res = await fetch(`${BASE_URL}/orders/create/adhoc`, {
    method:  'POST',
    headers: await headers(),
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Shiprocket order creation failed: ' + JSON.stringify(data));

  // Returns { order_id, shipment_id, status, ... }
  return {
    shiprocketOrderId:   data.order_id   || null,
    shiprocketShipmentId: data.shipment_id || null,
    awbCode:             data.awb_code   || null,
    status:              data.status     || null,
  };
}

/* ── Track shipment by AWB code ── */
export async function trackByAwb(awbCode) {
  const res = await fetch(`${BASE_URL}/courier/track/awb/${awbCode}`, {
    headers: await headers(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Tracking failed: ' + JSON.stringify(data));

  const info = data.tracking_data?.shipment_track?.[0] || {};
  return {
    currentStatus:  info.current_status      || 'Unknown',
    deliveredDate:  info.delivered_date      || null,
    etd:            info.etd                 || null,
    courierName:    info.courier_name        || null,
    awbCode:        info.awb_code            || awbCode,
    activities:     data.tracking_data?.shipment_track_activities || [],
  };
}

/* ── Track by Shiprocket order ID ── */
export async function trackByOrderId(shiprocketOrderId) {
  const res = await fetch(`${BASE_URL}/orders/show/${shiprocketOrderId}`, {
    headers: await headers(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Order fetch failed: ' + JSON.stringify(data));
  return data;
}

/* ── Cancel a Shiprocket order ── */
export async function cancelShiprocketOrder(shiprocketOrderIds) {
  const ids = Array.isArray(shiprocketOrderIds) ? shiprocketOrderIds : [shiprocketOrderIds];
  const res = await fetch(`${BASE_URL}/orders/cancel`, {
    method:  'POST',
    headers: await headers(),
    body:    JSON.stringify({ ids }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Shiprocket cancel failed: ' + JSON.stringify(data));
  return data;
}