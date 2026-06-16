const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const SHOPIFY_BASE = 'https://lumerastore.pl/cs/collections/all.atom';

let cache = { xml: null, builtAt: null };

function isCacheValid() {
  return cache.xml && cache.builtAt && (Date.now() - cache.builtAt) < CACHE_TTL_MS;
}

async function fetchAtomPage(page) {
  const res = await axios.get(`${SHOPIFY_BASE}?page=${page}`, {
    timeout: 15000,
    headers: { 'User-Agent': 'LumeraCZFeed/1.0' },
    responseType: 'text'
  });
  return res.data;
}

async function parseAtom(xml) {
  const parser = new xml2js.Parser({ explicitArray: true, trim: true });
  return parser.parseStringPromise(xml);
}

function extractImageFromSummary(summary) {
  if (!summary) return null;
  const str = Array.isArray(summary) ? summary[0] : summary;
  const content = typeof str === 'object' ? (str._ || '') : str;
  const match = content.match(/https?:\/\/cdn\.shopify\.com\/[^"'\s>]+/);
  return match ? match[0] : null;
}

function extractDescFromSummary(summary) {
  if (!summary) return '';
  const str = Array.isArray(summary) ? summary[0] : summary;
  const content = typeof str === 'object' ? (str._ || '') : str;
  // Strip HTML tags, collapse whitespace
  return content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function slugId(str) {
  return str
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove diacritics
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function getText(field) {
  if (!field) return '';
  const val = Array.isArray(field) ? field[0] : field;
  return typeof val === 'object' ? (val._ || '') : String(val || '');
}

function buildItems(entries) {
  const items = [];
  const seenIds = new Set();

  for (const entry of entries) {
    const title = getText(entry.title);
    const linkEl = entry.link ? entry.link[0] : null;
    const link = linkEl && linkEl.$ ? linkEl.$.href : '';
    const image = extractImageFromSummary(entry.summary);
    const description = extractDescFromSummary(entry.summary) || title;

    const variants = entry['s:variant'] || [];

    if (variants.length === 0) {
      items.push(makeItem({ id: slugId(getText(entry.id)), title, description, link, image, price: '0 PLN' }));
      continue;
    }

    for (const variant of variants) {
      const varTitle = getText(variant.title);
      const sku = getText(variant['s:sku']);

      const priceField = variant['s:price'] ? variant['s:price'][0] : null;
      const priceVal = priceField
        ? (typeof priceField === 'object' ? (priceField._ || '0') : String(priceField))
        : '0';
      const currency = (priceField && priceField.$ && priceField.$.currency) || 'PLN';
      const price = `${priceVal} ${currency}`;

      const parts = varTitle.split(' / ');
      const color = parts[0] && parts[0] !== 'Default Title' ? parts[0] : null;
      const size = parts[1] && parts[1] !== 'Default Title' ? parts[1] : null;

      // ASCII-safe unique ID: SKU_Color_Size
      const suffix = varTitle && varTitle !== 'Default Title'
        ? `_${slugId(varTitle.replace(/\s*\/\s*/g, '_'))}`
        : '';
      const itemId = sku ? `${sku}${suffix}` : slugId(`${link}${suffix}`);

      if (seenIds.has(itemId)) continue;
      seenIds.add(itemId);

      items.push(makeItem({
        id: itemId,
        title: `${title}${varTitle && varTitle !== 'Default Title' ? ' - ' + varTitle : ''}`,
        description,
        link,
        image,
        price,
        color,
        size
      }));
    }
  }

  return items;
}

function makeItem({ id, title, description, link, image, price, color, size }) {
  const item = {
    'g:id': [id],
    title: [title],
    'g:description': [description || title],
    link: [link],
    'g:image_link': [image || ''],
    'g:price': [price],
    'g:availability': ['in stock'],
    'g:condition': ['new'],
    'g:brand': ['Lumera'],
    'g:gender': ['female'],
    'g:age_group': ['adult']
  };
  if (color) item['g:color'] = [color];
  if (size) item['g:size'] = [size];
  return item;
}

async function buildFeed() {
  const allEntries = [];
  let page = 1;

  while (page <= 50) {
    let xml;
    try {
      xml = await fetchAtomPage(page);
    } catch (err) {
      console.error(`Fetch error page ${page}:`, err.message);
      break;
    }

    let parsed;
    try {
      parsed = await parseAtom(xml);
    } catch (err) {
      console.error(`Parse error page ${page}:`, err.message);
      break;
    }

    const entries = parsed && parsed.feed && parsed.feed.entry;
    if (!entries || entries.length === 0) {
      console.log(`Page ${page}: empty, stopping.`);
      break;
    }

    console.log(`Page ${page}: ${entries.length} entries`);
    allEntries.push(...entries);
    page++;
  }

  console.log(`Total entries: ${allEntries.length}`);

  const items = buildItems(allEntries);
  console.log(`Total items (variants): ${items.length}`);

  const feedObj = {
    rss: {
      $: { version: '2.0', 'xmlns:g': 'http://base.google.com/ns/1.0' },
      channel: [{
        title: ['Lumera CZ Product Feed'],
        link: ['https://lumerastore.pl'],
        description: ['Lumera Czech product catalog for Meta Shopping'],
        item: items
      }]
    }
  };

  const builder = new xml2js.Builder({
    xmldec: { version: '1.0', encoding: 'UTF-8' },
    renderOpts: { pretty: true, indent: '  ' }
  });

  return builder.buildObject(feedObj);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', cachedAt: cache.builtAt, itemCount: cache.itemCount || 0 });
});

app.get('/refresh', (req, res) => {
  cache = { xml: null, builtAt: null };
  res.json({ status: 'cache cleared' });
});

app.get('/debug', async (req, res) => {
  try {
    const xml = await fetchAtomPage(1);
    const parsed = await parseAtom(xml);
    const entry = parsed.feed.entry[0];
    const keys = Object.keys(entry);
    const variantSample = entry['s:variant'] ? entry['s:variant'][0] : null;
    res.json({ keys, variantSample, titleSample: entry.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/feed.xml', async (req, res) => {
  if (isCacheValid()) {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('X-Cache', 'HIT');
    return res.send(cache.xml);
  }

  try {
    const xml = await buildFeed();
    cache = { xml, builtAt: Date.now() };
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('X-Cache', 'MISS');
    res.send(xml);
  } catch (err) {
    console.error('Feed build error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Lumera CZ Feed running on port ${PORT}`);
});
