const BASE_URL = 'https://apiv2.shiprocket.in/v1/external';

let _token = null;
let _tokenExpiry = 0;

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
  _tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  return _token;
}

async function headers() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${await getToken()}`,
  };
}

/* ── Create a Shiprocket order ── */
export async function createShiprocketOrder({
  orderId, orderNumber, orderDate,
  customerName, customerEmail, customerPhone,
  address, city, pincode, state,
  productName, quantity, price,
  weight = 0.5,
}) {
  // Log what we received so empty fields are visible in the terminal
  console.log('[Shiprocket] createShiprocketOrder fields:', {
    orderId, orderNumber, customerName, customerPhone,
    address, city, pincode, state,
  });

  // Validate required fields before hitting Shiprocket — gives a clear error
  // instead of the cryptic "Please add billing/shipping address first" 400.
  const missing = [];
  if (!customerName?.toString().trim())  missing.push('customerName');
  if (!address?.toString().trim())       missing.push('address');
  if (!city?.toString().trim())          missing.push('city');
  if (!pincode?.toString().trim())       missing.push('pincode');
  if (!customerPhone?.toString().trim()) missing.push('customerPhone');

  if (missing.length) {
    throw new Error(
      `Shiprocket order #${orderNumber} missing required fields: ${missing.join(', ')}. ` +
      `Ensure the customer has a saved address and phone number.`
    );
  }

  const body = {
    order_id:          String(orderNumber),
    order_date:        orderDate,
    pickup_location:   'Primary',
    billing_customer_name:  customerName.toString().trim(),
    billing_address:        address.toString().trim(),
    billing_city:           city.toString().trim(),
    billing_pincode:        pincode.toString().trim(),
    billing_state:          state?.toString().trim() || city.toString().trim(),
    billing_country:        'India',
    billing_email:          customerEmail || '',
    billing_phone:          customerPhone.toString().trim(),
    shipping_is_billing:    true,
    order_items: [
      {
        name:         productName,
        sku:          `SKU-${orderId}`,
        units:        quantity,
        selling_price: price,
      },
    ],
    payment_method: 'Prepaid',
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

  return {
    shiprocketOrderId:    data.order_id    || null,
    shiprocketShipmentId: data.shipment_id || null,
    awbCode:              data.awb_code    || null,
    courierId:            data.courier_id  || null,
    status:               data.status      || null,
  };
}

/* ── Assign AWB (auto-assign cheapest courier) and get label URL ── */
export async function assignAwbAndLabel(shipmentId) {
  // 1. Auto-assign courier
  const assignRes = await fetch(`${BASE_URL}/courier/assign/awb`, {
    method: 'POST',
    headers: await headers(),
    body: JSON.stringify({ shipment_id: [String(shipmentId)] }),
  });
  const assignData = await assignRes.json();

  const awbCode   = assignData?.response?.data?.awb_code   || null;
  const courierId = assignData?.response?.data?.courier_id || null;

  if (!awbCode) {
    console.warn('[shiprocket] AWB assign response:', JSON.stringify(assignData));
  }

  // 2. Generate label
  let labelUrl = null;
  try {
    const labelRes = await fetch(`${BASE_URL}/courier/generate/label`, {
      method: 'POST',
      headers: await headers(),
      body: JSON.stringify({ shipment_id: [String(shipmentId)] }),
    });
    const labelData = await labelRes.json();
    labelUrl = labelData?.label_url || null;
  } catch (e) {
    console.warn('[shiprocket] Label generation failed:', e.message);
  }

  return { awbCode, courierId, labelUrl };
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
    trackingUrl:    info.track_url           || `https://shiprocket.co/tracking/${awbCode}`,
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
/* ── Check courier serviceability for a pincode pair ── */
export async function getAvailableCouriers(originPincode, destPincode, weight = 0.5, cod = false, declaredValue = 500) {
  const params = new URLSearchParams({
    pickup_postcode:   String(originPincode),
    delivery_postcode: String(destPincode),
    weight:            String(weight),
    cod:               cod ? 1 : 0,
    declared_value:    String(declaredValue),
  });

  const res = await fetch(`${BASE_URL}/courier/serviceability/?${params}`, {
    headers: await headers(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Serviceability check failed: ' + JSON.stringify(data));

  const companies =
    data?.data?.available_courier_companies ||
    data?.available_courier_companies ||
    [];

  return companies.map((c) => ({
    courierId:      c.courier_company_id,
    courierName:    c.courier_name,
    rate:           parseFloat(c.rate || c.freight_charge || 0),
    etaDays:        c.estimated_delivery_days || c.etd || '—',
    cod:            !!c.cod,
    minWeight:      c.min_weight || 0,
    maxWeight:      c.max_weight || 0,
    logo:           c.courier_logo_url || null,
    ratingScore:    c.rating || null,
    performanceSla: c.performance_sla || null,
  }));
}