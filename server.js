// Ji Fire order server
// --------------------
// Receives orders from the Ji Fire mobile app, re-prices them from Shopify,
// and creates real orders in Shopify admin. Card payments go through
// HyperPay (COPYandPAY) and are verified server-side before the order is
// marked as paid. Cash on delivery, store pickup and Aqsati orders are created
// with payment pending.
//
// Node.js 18+ only, no npm packages. Configure with environment variables or
// a `.env` file next to this file (see .env.example).

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------- config ---

function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const bool = (k, d = false) => {
  const v = env(k);
  return v === '' ? d : /^(1|true|yes|on)$/i.test(v);
};

const CFG = {
  port: Number(env('PORT', '8080')),
  publicUrl: env('PUBLIC_URL').replace(/\/+$/, ''),
  appKey: env('APP_KEY'),
  shop: env('SHOPIFY_SHOP'), // e.g. tfmwtv-d3.myshopify.com
  apiVersion: env('SHOPIFY_API_VERSION', '2026-10'),
  clientId: env('SHOPIFY_CLIENT_ID'),
  clientSecret: env('SHOPIFY_CLIENT_SECRET'),
  staticToken: env('SHOPIFY_ADMIN_TOKEN'), // optional: legacy shpat_ token
  adminBase: env('SHOPIFY_ADMIN_BASE'), // tests only
  sendReceipt: bool('SEND_ORDER_RECEIPT', false),
  upsertCustomer: bool('UPSERT_CUSTOMER', true),
  orderTag: env('ORDER_TAG', 'تطبيق جي فاير'),
  defaultDeliveryFee: Number(env('DELIVERY_FEE', '0')),
  deliveryFees: parseFees(env('DELIVERY_FEES')),
  freeDeliveryOver: Number(env('FREE_DELIVERY_OVER', '0')),
  pickup: {
    enabled: bool('PICKUP_ENABLED', true),
    title: env('PICKUP_TITLE', 'استلام من المتجر'),
    address: env('PICKUP_ADDRESS', ''),
    hours: env('PICKUP_HOURS', ''),
  },
  cod: bool('COD_ENABLED', true),
  aqsati: {
    enabled: bool('AQSATI_ENABLED', true),
    // Existing Aqsati site: after the Shopify order is created the customer is
    // sent there. Placeholders: {order_id} {order_number} {order_name} {total}
    // {phone} {name} {email}
    redirectUrl: env('AQSATI_REDIRECT_URL'),
    gateway: env('AQSATI_GATEWAY_NAME', 'Aqsati'),
    note: env(
      'AQSATI_NOTE',
      'سيتواصل معك فريق جي فاير لإكمال إجراءات التقسيط عبر كي كارد قبل التوصيل.'
    ),
  },
  hyperpay: {
    host: env('HYPERPAY_HOST', 'https://eu-prod.oppwa.com').replace(/\/+$/, ''),
    entityId: env('HYPERPAY_ENTITY_ID'),
    token: env('HYPERPAY_ACCESS_TOKEN'),
    currency: env('HYPERPAY_CURRENCY', 'IQD'),
    rate: Number(env('HYPERPAY_RATE', '1')) || 1, // shop currency -> gateway currency
    brands: env('HYPERPAY_BRANDS', 'VISA MASTER'),
    testMode: env('HYPERPAY_TEST_MODE'), // EXTERNAL / INTERNAL on test host only
  },
  dataDir: env('DATA_DIR', path.join(__dirname, 'data')),
  ordersPerIp: Number(env('ORDERS_PER_IP_10MIN', '6')),
};

const IRAQ_GOVERNORATES = [
  'بغداد', 'البصرة', 'نينوى', 'أربيل', 'السليمانية', 'دهوك', 'كركوك',
  'الأنبار', 'بابل', 'كربلاء', 'النجف', 'القادسية', 'المثنى', 'ذي قار',
  'ميسان', 'واسط', 'صلاح الدين', 'ديالى', 'حلبجة',
];

function parseFees(s) {
  // "بغداد:5000,البصرة:7000"
  const out = {};
  for (const part of s.split(/[,،;]/)) {
    const [k, v] = part.split(':').map((x) => (x || '').trim());
    if (k && v && !Number.isNaN(Number(v))) out[k] = Number(v);
  }
  return out;
}

const hyperpayEnabled = () =>
  Boolean(CFG.hyperpay.entityId && CFG.hyperpay.token && CFG.publicUrl);

// ------------------------------------------------------------ persistence ---

fs.mkdirSync(CFG.dataDir, { recursive: true });
const STORE_FILE = path.join(CFG.dataDir, 'state.json');

const state = (() => {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return { pending: {}, idempotency: {} };
  }
})();

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const now = Date.now();
    for (const [k, v] of Object.entries(state.idempotency)) {
      if (now - v.at > 24 * 3600e3) delete state.idempotency[k];
    }
    for (const [k, v] of Object.entries(state.pending)) {
      if (now - v.at > 3 * 24 * 3600e3) delete state.pending[k];
    }
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STORE_FILE);
  }, 200);
}

// --------------------------------------------------------- shopify admin ---

let tokenCache = { token: CFG.staticToken || null, exp: CFG.staticToken ? Infinity : 0 };

async function adminToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  if (!CFG.clientId || !CFG.clientSecret) {
    throw new AppError(500, 'إعدادات Shopify غير مكتملة على الخادم');
  }
  const base = CFG.adminBase || `https://${CFG.shop}`;
  const res = await fetch(`${base}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CFG.clientId,
      client_secret: CFG.clientSecret,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    log('token error', res.status, json);
    throw new AppError(502, 'تعذّر الاتصال بإدارة المتجر');
  }
  const ttl = Number(json.expires_in || 86399) * 1000;
  tokenCache = { token: json.access_token, exp: Date.now() + ttl - 5 * 60e3 };
  return tokenCache.token;
}

async function admin(query, variables = {}) {
  const base = CFG.adminBase || `https://${CFG.shop}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${base}/admin/api/${CFG.apiVersion}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': await adminToken(),
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 && !CFG.staticToken) {
      tokenCache = { token: null, exp: 0 };
      continue;
    }
    const json = await res.json().catch(() => ({}));
    const throttled = (json.errors || []).some((e) => e?.extensions?.code === 'THROTTLED');
    if (throttled || res.status === 429) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!res.ok || json.errors) {
      log('admin error', res.status, JSON.stringify(json.errors || json).slice(0, 800));
      throw new AppError(502, 'خطأ من إدارة المتجر، حاول مرة أخرى');
    }
    return json.data;
  }
  throw new AppError(503, 'المتجر مشغول حالياً، حاول بعد لحظات');
}

const VARIANTS_QUERY = `
query Variants($ids: [ID!]!) {
  shop { currencyCode }
  nodes(ids: $ids) {
    ... on ProductVariant {
      id title sku price availableForSale
      product { title status }
    }
  }
}`;

const ORDER_CREATE = `
mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order { id name totalPriceSet { shopMoney { amount currencyCode } } }
    userErrors { field message }
  }
}`;

/** Re-prices the cart from Shopify. Never trusts prices sent by the app. */
async function priceCart(lines) {
  const ids = [...new Set(lines.map((l) => l.variantId))];
  const data = await admin(VARIANTS_QUERY, { ids });
  const currency = data.shop.currencyCode;
  const byId = new Map((data.nodes || []).filter(Boolean).map((n) => [n.id, n]));
  const items = [];
  for (const l of lines) {
    const v = byId.get(l.variantId);
    if (!v || v.product?.status !== 'ACTIVE') {
      throw new AppError(409, 'أحد المنتجات في السلة لم يعد متوفراً، حدّث السلة وحاول مرة أخرى');
    }
    if (!v.availableForSale) {
      throw new AppError(409, `نفدت الكمية من: ${v.product.title}`);
    }
    items.push({
      variantId: v.id,
      quantity: l.quantity,
      title: v.product.title,
      variantTitle: v.title === 'Default Title' ? '' : v.title,
      price: Number(v.price),
    });
  }
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  return { items, subtotal, currency };
}

function deliveryFee(order, subtotal) {
  if (order.delivery === 'pickup') return 0;
  if (CFG.freeDeliveryOver > 0 && subtotal >= CFG.freeDeliveryOver) return 0;
  const g = order.address?.governorate;
  return CFG.deliveryFees[g] ?? CFG.defaultDeliveryFee;
}

const PAYMENT_LABEL = {
  cod: 'الدفع عند الاستلام',
  card: 'بطاقة (HyperPay)',
  aqsati: 'أقساطي (كي كارد)',
};

async function createShopifyOrder(order, priced, { paid, gatewayRef, review }) {
  const fee = deliveryFee(order, priced.subtotal);
  const total = priced.subtotal + fee;
  const money = (amount) => ({
    shopMoney: { amount: amount.toFixed(2), currencyCode: priced.currency },
  });
  const [firstName, ...rest] = order.customer.name.trim().split(/\s+/);
  const lastName = rest.join(' ') || firstName;
  const pickup = order.delivery === 'pickup';

  const address = pickup
    ? null
    : {
        firstName,
        lastName,
        phone: order.customer.phone,
        address1: order.address.area + (order.address.street ? ` - ${order.address.street}` : ''),
        address2: order.address.landmark || null,
        city: order.address.governorate,
        countryCode: 'IQ',
      };

  const gateway =
    order.payment === 'card'
      ? 'HyperPay'
      : order.payment === 'aqsati'
        ? CFG.aqsati.gateway
        : 'Cash on Delivery (COD)';

  const tags = [CFG.orderTag, PAYMENT_LABEL[order.payment], pickup ? 'استلام من المتجر' : 'توصيل'];
  if (review) tags.push('دفع قيد المراجعة');

  const attrs = [
    { key: 'طريقة الدفع', value: PAYMENT_LABEL[order.payment] },
    { key: 'طريقة الاستلام', value: pickup ? 'استلام من المتجر' : 'توصيل' },
  ];
  if (gatewayRef) attrs.push({ key: 'مرجع HyperPay', value: gatewayRef });

  const input = {
    currency: priced.currency,
    lineItems: priced.items.map((i) => ({
      variantId: i.variantId,
      quantity: i.quantity,
      priceSet: money(i.price),
    })),
    phone: order.customer.phone,
    email: order.customer.email || null,
    note: order.note || null,
    tags,
    customAttributes: attrs,
    sourceName: 'jifire-app',
    sourceIdentifier: order.idempotencyKey,
    financialStatus: paid ? 'PAID' : 'PENDING',
    transactions: [
      {
        kind: 'SALE',
        status: paid ? 'SUCCESS' : 'PENDING',
        gateway,
        amountSet: money(total),
        ...(gatewayRef ? { authorizationCode: gatewayRef } : {}),
      },
    ],
    shippingLines: [
      {
        title: pickup ? CFG.pickup.title : 'توصيل',
        code: pickup ? 'pickup' : 'delivery',
        priceSet: money(fee),
      },
    ],
    ...(address ? { shippingAddress: address, billingAddress: address } : {}),
  };
  if (CFG.upsertCustomer) {
    input.customer = {
      toUpsert: {
        firstName,
        lastName,
        phone: order.customer.phone,
        ...(order.customer.email ? { email: order.customer.email } : {}),
      },
    };
  }

  const options = {
    inventoryBehaviour: 'DECREMENT_OBEYING_POLICY',
    sendReceipt: CFG.sendReceipt && Boolean(order.customer.email),
  };

  let data = await admin(ORDER_CREATE, { order: input, options });
  let errs = data.orderCreate.userErrors;
  if (errs.length && input.customer) {
    // Customer upsert can fail (e.g. phone used by another customer); retry without it.
    log('orderCreate retry without customer', JSON.stringify(errs));
    delete input.customer;
    data = await admin(ORDER_CREATE, { order: input, options });
    errs = data.orderCreate.userErrors;
  }
  if (errs.length) {
    log('orderCreate userErrors', JSON.stringify(errs));
    const msg = errs.map((e) => e.message).join('، ');
    throw new AppError(422, /inventory|stock|available/i.test(msg)
      ? 'الكمية المطلوبة غير متوفرة حالياً'
      : 'تعذّر إنشاء الطلب: ' + msg);
  }
  const o = data.orderCreate.order;
  return { orderId: o.id, orderName: o.name, total, deliveryFee: fee, currency: priced.currency };
}

function aqsatiUrl(order, created) {
  const t = CFG.aqsati.redirectUrl;
  if (!t) return null;
  const vals = {
    order_id: created.orderId.split('/').pop(),
    order_gid: created.orderId,
    order_name: created.orderName,
    order_number: created.orderName.replace(/^#/, ''),
    total: String(Math.round(created.total)),
    phone: order.customer.phone,
    name: order.customer.name,
    email: order.customer.email || '',
  };
  return t.replace(/\{(\w+)\}/g, (m, k) => (k in vals ? encodeURIComponent(vals[k]) : m));
}

// -------------------------------------------------------------- hyperpay ---

const HP_SUCCESS = /^(000\.000\.|000\.100\.1|000\.[36])/;
const HP_REVIEW = /^(000\.400\.0[^3]|000\.400\.100)/;
const HP_PENDING = /^(000\.200)/;

async function hyperpayPrepare(amount, ref, order) {
  const hp = CFG.hyperpay;
  const gatewayAmount = (amount * hp.rate).toFixed(2);
  const body = new URLSearchParams({
    entityId: hp.entityId,
    amount: gatewayAmount,
    currency: hp.currency,
    paymentType: 'DB',
    merchantTransactionId: ref,
    'customer.mobile': order.customer.phone,
    'customer.givenName': order.customer.name.split(/\s+/)[0],
    'customer.surname': order.customer.name.split(/\s+/).slice(1).join(' ') || '-',
    ...(order.customer.email ? { 'customer.email': order.customer.email } : {}),
    'billing.country': 'IQ',
    'billing.city': order.address?.governorate || 'Baghdad',
    'billing.street1': order.address?.area || 'Store pickup',
    ...(hp.testMode ? { testMode: hp.testMode } : {}),
  });
  const res = await fetch(`${hp.host}/v1/checkouts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hp.token}` },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.id) {
    log('hyperpay prepare failed', res.status, JSON.stringify(json).slice(0, 500));
    throw new AppError(502, 'تعذّر بدء الدفع بالبطاقة، جرّب طريقة دفع أخرى');
  }
  return { checkoutId: json.id, integrity: json.integrity || null, gatewayAmount };
}

async function hyperpayStatus(checkoutId) {
  const hp = CFG.hyperpay;
  const url = `${hp.host}/v1/checkouts/${encodeURIComponent(checkoutId)}/payment?entityId=${encodeURIComponent(hp.entityId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${hp.token}` } });
  return res.json().catch(() => ({}));
}

// ---------------------------------------------------------- validation ---

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizePhone(p) {
  let d = String(p || '')
    .replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c))
    .replace(/[۰-۹]/g, (c) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c))
    .replace(/[^\d+]/g, '');
  if (d.startsWith('+964')) d = '0' + d.slice(4);
  else if (d.startsWith('00964')) d = '0' + d.slice(5);
  else if (d.startsWith('964')) d = '0' + d.slice(3);
  if (/^7\d{9}$/.test(d)) d = '0' + d;
  return /^07[3-9]\d{8}$/.test(d) ? '+964' + d.slice(1) : null;
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function validateOrder(body) {
  const o = body || {};
  const lines = Array.isArray(o.lines) ? o.lines : [];
  if (!lines.length || lines.length > 30) throw new AppError(400, 'السلة فارغة');
  const cleanLines = lines.map((l) => {
    const q = Number(l.quantity);
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(String(l.variantId)) || !Number.isInteger(q) || q < 1 || q > 20) {
      throw new AppError(400, 'بيانات السلة غير صحيحة');
    }
    return { variantId: l.variantId, quantity: q };
  });
  const name = str(o.customer?.name, 80);
  if (name.length < 3) throw new AppError(400, 'اكتب الاسم الكامل');
  const phone = normalizePhone(o.customer?.phone);
  if (!phone) throw new AppError(400, 'رقم الهاتف غير صحيح، مثال: 07701234567');
  const email = str(o.customer?.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'البريد الإلكتروني غير صحيح');

  const delivery = o.delivery === 'pickup' ? 'pickup' : 'shipping';
  if (delivery === 'pickup' && !CFG.pickup.enabled) throw new AppError(400, 'الاستلام من المتجر غير متاح حالياً');

  let address = null;
  if (delivery === 'shipping') {
    const governorate = str(o.address?.governorate, 40);
    if (!IRAQ_GOVERNORATES.includes(governorate)) throw new AppError(400, 'اختر المحافظة');
    const area = str(o.address?.area, 120);
    if (area.length < 2) throw new AppError(400, 'اكتب المنطقة أو الحي');
    address = {
      governorate,
      area,
      street: str(o.address?.street, 160),
      landmark: str(o.address?.landmark, 160),
    };
  }

  const payment = ['cod', 'card', 'aqsati'].includes(o.payment) ? o.payment : null;
  if (!payment) throw new AppError(400, 'اختر طريقة الدفع');
  if (payment === 'cod' && !CFG.cod) throw new AppError(400, 'الدفع عند الاستلام غير متاح');
  if (payment === 'card' && !hyperpayEnabled()) throw new AppError(400, 'الدفع بالبطاقة غير متاح حالياً');
  if (payment === 'aqsati' && !CFG.aqsati.enabled) throw new AppError(400, 'أقساطي غير متاح حالياً');

  const idempotencyKey = str(o.idempotencyKey, 64);
  if (!/^[A-Za-z0-9-]{16,64}$/.test(idempotencyKey)) throw new AppError(400, 'طلب غير صالح');

  return {
    lines: cleanLines,
    customer: { name, phone, email },
    delivery,
    address,
    payment,
    note: str(o.note, 500),
    marketing: o.marketing === true,
    idempotencyKey,
  };
}

// ---------------------------------------------------------- rate limits ---

const hits = new Map();
function rateLimit(ip, key, max, windowMs) {
  const k = `${key}:${ip}`;
  const now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw new AppError(429, 'محاولات كثيرة، انتظر قليلاً ثم حاول مجدداً');
  arr.push(now);
  hits.set(k, arr);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.some((t) => now - t < 3600e3)) hits.delete(k);
}, 600e3).unref();

// -------------------------------------------------------------- handlers ---

async function handleConfig() {
  return {
    currency: 'IQD',
    governorates: IRAQ_GOVERNORATES,
    delivery: {
      defaultFee: CFG.defaultDeliveryFee,
      fees: CFG.deliveryFees,
      freeOver: CFG.freeDeliveryOver,
    },
    pickup: CFG.pickup,
    payments: [
      ...(CFG.cod ? [{ id: 'cod', title: 'الدفع عند الاستلام', subtitle: 'ادفع نقداً عند وصول طلبك' }] : []),
      ...(hyperpayEnabled()
        ? [{ id: 'card', title: 'الدفع الإلكتروني بالبطاقة', subtitle: CFG.hyperpay.brands.replace(/\s+/g, ' · ') }]
        : []),
      ...(CFG.aqsati.enabled
        ? [{ id: 'aqsati', title: 'أقساطي – كي كارد', subtitle: 'قسّط مشترياتك عبر بطاقة كي', note: CFG.aqsati.note }]
        : []),
    ],
  };
}

async function handleOrder(body, ip) {
  const order = validateOrder(body);

  const prior = state.idempotency[order.idempotencyKey];
  if (prior) return prior.result;

  rateLimit(ip, 'order', CFG.ordersPerIp, 10 * 60e3);
  rateLimit(order.customer.phone, 'order-phone', 4, 10 * 60e3);

  const priced = await priceCart(order.lines);
  const fee = deliveryFee(order, priced.subtotal);
  const total = priced.subtotal + fee;

  let result;
  if (order.payment === 'card') {
    const ref = 'JF' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const hp = await hyperpayPrepare(total, ref, order);
    const token = crypto.randomBytes(18).toString('base64url');
    state.pending[token] = {
      at: Date.now(),
      order,
      checkoutId: hp.checkoutId,
      integrity: hp.integrity,
      amount: total,
      priced,
      ref,
      status: 'waiting',
    };
    result = {
      status: 'payment_required',
      paymentUrl: `${CFG.publicUrl}/pay/${token}`,
      total,
      deliveryFee: fee,
      currency: priced.currency,
    };
  } else {
    const created = await createShopifyOrder(order, priced, { paid: false });
    const redirectUrl = order.payment === 'aqsati' ? aqsatiUrl(order, created) : null;
    result = {
      status: 'created',
      ...(redirectUrl ? { redirectUrl } : {}),
      orderName: created.orderName,
      total: created.total,
      deliveryFee: created.deliveryFee,
      currency: created.currency,
      message:
        order.payment === 'aqsati'
          ? redirectUrl
            ? 'تم تسجيل طلبك. أكمل خطوات التقسيط في صفحة أقساطي.'
            : CFG.aqsati.note
          : order.delivery === 'pickup'
            ? 'طلبك جاهز للاستلام بعد تأكيده، سنتصل بك.'
            : 'سنتصل بك لتأكيد الطلب ثم نرسله إليك.',
    };
  }
  state.idempotency[order.idempotencyKey] = { at: Date.now(), result };
  saveState();
  return result;
}

function payPage(token, p) {
  const hp = CFG.hyperpay;
  const integrity = p.integrity
    ? ` integrity="${escapeHtml(p.integrity)}" crossorigin="anonymous"`
    : '';
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>الدفع بالبطاقة</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;background:#0A0A0C;color:#F5F5F7}
.wrap{max-width:520px;margin:0 auto;padding:20px}
.card{background:#141417;border:1px solid #2A2A30;border-radius:20px;padding:18px;margin-bottom:16px}
.total{display:flex;justify-content:space-between;font-size:18px;font-weight:800}
.total b{color:#E2B85A}
.muted{color:#8E8E96;font-size:13px;margin-top:6px}
.wpwl-form{max-width:100%!important}
.wpwl-button-pay{background:linear-gradient(135deg,#F6D88F,#E2B85A,#B0832B)!important;border:0!important;color:#000!important;font-weight:800!important;border-radius:14px!important;width:100%}
</style>
<script>var wpwlOptions={locale:"ar",style:"card",paymentTarget:"_top"};</script>
<script src="${hp.host}/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(p.checkoutId)}"${integrity}></script>
</head><body><div class="wrap">
<div class="card"><div class="total"><span>المبلغ</span><b>${formatIqd(p.amount)}</b></div>
<div class="muted">الدفع آمن ومشفّر عبر HyperPay. لا نحفظ بيانات بطاقتك.</div></div>
<form action="${CFG.publicUrl}/pay/${token}/result" class="paymentWidgets" data-brands="${escapeHtml(hp.brands)}"></form>
</div></body></html>`;
}

async function handlePayResult(token) {
  const p = state.pending[token];
  if (!p) return { ok: false, message: 'انتهت صلاحية عملية الدفع' };
  if (p.status === 'done') return { ok: true, orderName: p.orderName, review: p.review };

  // Avoid creating two orders if the page is refreshed during processing.
  if (p.status === 'processing') {
    for (let i = 0; i < 20 && state.pending[token].status === 'processing'; i++) await sleep(500);
    const q = state.pending[token];
    if (q.status === 'done') return { ok: true, orderName: q.orderName, review: q.review };
  }

  const status = await hyperpayStatus(p.checkoutId);
  const code = status?.result?.code || '';
  log('hyperpay result', token.slice(0, 6), code, status?.result?.description);

  const success = HP_SUCCESS.test(code);
  const review = HP_REVIEW.test(code) || HP_PENDING.test(code);
  if (!success && !review) {
    return { ok: false, message: 'لم تكتمل عملية الدفع: ' + (status?.result?.description || 'مرفوضة') };
  }
  // Make sure the amount charged matches what we expected.
  const expected = (p.amount * CFG.hyperpay.rate).toFixed(2);
  if (status.amount && Number(status.amount).toFixed(2) !== expected) {
    log('hyperpay amount mismatch', status.amount, expected);
    return { ok: false, message: 'مبلغ الدفع غير مطابق، تواصل مع المتجر' };
  }

  p.status = 'processing';
  try {
    // The customer already paid: use the prices captured when payment started.
    const priced = p.priced;
    const created = await createShopifyOrder(p.order, priced, {
      paid: success,
      gatewayRef: status.id || p.ref,
      review: !success,
    });
    Object.assign(p, { status: 'done', orderName: created.orderName, review: !success });
    state.idempotency[p.order.idempotencyKey] = {
      at: Date.now(),
      result: { status: 'created', orderName: created.orderName, total: created.total, currency: created.currency },
    };
    saveState();
    return { ok: true, orderName: created.orderName, review: !success };
  } catch (e) {
    p.status = 'paid_not_created';
    saveState();
    log('PAID BUT ORDER NOT CREATED', p.ref, status.id, e.message);
    return {
      ok: false,
      message: `تم الدفع لكن تعذّر تسجيل الطلب تلقائياً. احتفظ بالرمز ${p.ref} وتواصل مع المتجر.`,
    };
  }
}

// ---------------------------------------------------------------- server ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const formatIqd = (n) => Math.round(n).toLocaleString('en-US') + ' د.ع';

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new AppError(413, 'الطلب كبير جداً'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket.remoteAddress || '').trim();
}

function checkAppKey(req) {
  if (CFG.appKey && req.headers['x-app-key'] !== CFG.appKey) {
    throw new AppError(401, 'غير مصرّح');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });

    if (req.method === 'GET' && p === '/api/config') {
      checkAppKey(req);
      return send(res, 200, await handleConfig());
    }

    if (req.method === 'POST' && p === '/api/orders') {
      checkAppKey(req);
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new AppError(400, 'طلب غير صالح');
      }
      return send(res, 200, await handleOrder(body, clientIp(req)));
    }

    let m;
    if (req.method === 'GET' && (m = p.match(/^\/pay\/([\w-]{20,40})$/))) {
      const pend = state.pending[m[1]];
      if (!pend || pend.status !== 'waiting') {
        return redirect(res, `${CFG.publicUrl}/pay/done?ok=0&msg=${encodeURIComponent('انتهت صلاحية عملية الدفع')}`);
      }
      return send(res, 200, payPage(m[1], pend), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && (m = p.match(/^\/pay\/([\w-]{20,40})\/result$/))) {
      rateLimit(clientIp(req), 'pay-result', 30, 10 * 60e3);
      const r = await handlePayResult(m[1]);
      const qs = r.ok
        ? `ok=1&order=${encodeURIComponent(r.orderName)}${r.review ? '&review=1' : ''}`
        : `ok=0&msg=${encodeURIComponent(r.message)}`;
      return redirect(res, `${CFG.publicUrl}/pay/done?${qs}`);
    }

    if (req.method === 'GET' && p === '/pay/done') {
      const ok = url.searchParams.get('ok') === '1';
      const text = ok
        ? `تم الدفع وتسجيل طلبك ${escapeHtml(url.searchParams.get('order') || '')}`
        : escapeHtml(url.searchParams.get('msg') || 'لم يكتمل الدفع');
      return send(
        res,
        200,
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#0A0A0C;color:#F5F5F7;font-family:system-ui;display:grid;place-items:center;height:90vh;text-align:center"><h2>${text}</h2>`,
        'text/html; charset=utf-8'
      );
    }

    send(res, 404, { error: 'غير موجود' });
  } catch (e) {
    const status = e instanceof AppError ? e.status : 500;
    if (status >= 500) log('error', req.method, p, e.stack || e.message);
    send(res, status, { error: e instanceof AppError ? e.message : 'خطأ في الخادم، حاول مرة أخرى' });
  }
});

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

if (require.main === module) {
  const missing = [];
  if (!CFG.shop && !CFG.adminBase) missing.push('SHOPIFY_SHOP');
  if (!CFG.staticToken && (!CFG.clientId || !CFG.clientSecret)) {
    missing.push('SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET');
  }
  if (!CFG.publicUrl) missing.push('PUBLIC_URL');
  if (missing.length) console.warn('⚠️  Missing settings:', missing.join(', '));
  if (!CFG.appKey) console.warn('⚠️  APP_KEY is empty: anyone can call /api/orders');
  server.listen(CFG.port, () => {
    log(`Ji Fire order server on :${CFG.port} | card payments: ${hyperpayEnabled() ? 'on' : 'off'}`);
  });
}

module.exports = { server, normalizePhone, validateOrder, parseFees, CFG };
