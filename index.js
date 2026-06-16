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
  const url = `${SHOPIFY_BASE}?page=${page}`;
  const res = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'LumeraCZFeed/1.0' }
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

function buildItems(entries) {
  const items = [];

  for (const entry of entries) {
    const title = (entry.title && entry.title[0]) ? (typeof entry.title[0] === 'object' ? entry.title[0]._ : entry.title[0]) : '';
    const linkEl = entry.link ? entry.link[0] : null;
    const link = linkEl && linkEl.$ ? linkEl.$.href : '';
    const summary = entry.summary ? entry.summary[0] : null;
    const image = extractImageFromSummary(summary);

    // s: namespace fields
    const ns = 's';
    const variants = entry[`${ns}:variant`] || [];
    const entryPrice = entry[`${ns}:price`] ? entry[`${ns}:price`][0] : null;

    if (variants.length === 0) {
      // No variants — emit a single item
      const id = entry.id ? entry.id[0] : link;
      const price = entryPrice ? `${entryPrice} CZK` : '0 CZK';

      items.push({
        'g:id': [id],
        'title': [title],
        'link': [link],
        'g:image_link': image ? [image] : [''],
        'g:price': [price],
        'g:availability': ['in stock'],
        'g:condition': ['new'],
        'g:brand': ['Lumera'],
        'g:gender': ['female'],
        'g:age_group': ['adult']
      });
    } else {
      for (const variant of variants) {
        const varId = variant.$ ? variant.$.id : '';
        const varTitle = variant.$ ? (variant.$.title || title) : title;
        const varPrice = variant.$ ? (variant.$.price || entryPrice || '0') : (entryPrice || '0');
        const varColor = variant.$ ? variant.$.option1 : null;
        const varSize = variant.$ ? variant.$.option2 : null;

        const item = {
          'g:id': [varId || `${link}_${varTitle}`],
          'title': [`${title}${varTitle && varTitle !== 'Default Title' ? ' - ' + varTitle : ''}`],
          'link': [link],
          'g:image_link': image ? [image] : [''],
          'g:price': [`${varPrice} CZK`],
          'g:availability': ['in stock'],
          'g:condition': ['new'],
          'g:brand': ['Lumera'],
          'g:gender': ['female'],
          'g:age_group': ['adult']
        };

        if (varColor && varColor !== 'Default Title') item['g:color'] = [varColor];
        if (varSize && varSize !== 'Default Title') item['g:size'] = [varSize];

        items.push(item);
      }
    }
  }

  return items;
}

async function buildFeed() {
  const allEntries = [];
  let page = 1;

  while (true) {
    let xml;
    try {
      xml = await fetchAtomPage(page);
    } catch (err) {
      console.error(`Failed to fetch page ${page}:`, err.message);
      break;
    }

    let parsed;
    try {
      parsed = await parseAtom(xml);
    } catch (err) {
      console.error(`Failed to parse page ${page}:`, err.message);
      break;
    }

    const entries = parsed && parsed.feed && parsed.feed.entry;
    if (!entries || entries.length === 0) {
      console.log(`Page ${page}: no entries, stopping.`);
      break;
    }

    console.log(`Page ${page}: ${entries.length} entries`);
    allEntries.push(...entries);
    page++;

    // Safety limit
    if (page > 50) break;
  }

  console.log(`Total entries fetched: ${allEntries.length}`);

  const items = buildItems(allEntries);

  const feedObj = {
    rss: {
      $: {
        version: '2.0',
        'xmlns:g': 'http://base.google.com/ns/1.0'
      },
      channel: [
        {
          title: ['Lumera CZ Product Feed'],
          link: ['https://lumerastore.pl'],
          description: ['Lumera Czech product catalog for Meta Shopping'],
          item: items
        }
      ]
    }
  };

  const builder = new xml2js.Builder({
    xmldec: { version: '1.0', encoding: 'UTF-8' },
    renderOpts: { pretty: true, indent: '  ' }
  });

  return builder.buildObject(feedObj);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', cachedAt: cache.builtAt });
});

app.get('/refresh', async (req, res) => {
  cache = { xml: null, builtAt: null };
  res.json({ status: 'cache cleared' });
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
