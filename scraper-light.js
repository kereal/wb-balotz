/**
 * Полное копирование запроса из браузера
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const https = require('https');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const db = new Database(path.join(__dirname, 'products-light.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    wb_id INTEGER PRIMARY KEY,
    name TEXT,
    price INTEGER,
    sale_price INTEGER,
    feedback_points INTEGER,
    brand TEXT,
    seller TEXT,
    review_rating REAL,
    feedbacks INTEGER,
    url TEXT,
    found_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// =====================================================
// ИСПРАВЛЕННАЯ ФУНКЦИЯ ЗАПРОСА
// =====================================================
function makeRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: headers
    };
    
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let body;
        try {
          const enc = res.headers['content-encoding'];
          if (enc === 'br') body = zlib.brotliDecompressSync(buf).toString();
          else if (enc === 'gzip') body = zlib.gunzipSync(buf).toString();
          else body = buf.toString();
        } catch { body = buf.toString(); }
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// =====================================================
// MAIN
// =====================================================
async function main() {
  console.log('\n🚀 WB Light - Через браузер\n');
  console.log('='.repeat(60));
  console.log(`💡 Память: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB\n`);
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });
  
  const page = await browser.newPage();
  
  // Блокируем ресурсы
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image', 'font', 'stylesheet', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });
  
  // Перехватываем запрос
  let apiUrl = null;
  let apiHeaders = null;
  let apiProducts = [];
  
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('search') && res.status() === 200) {
      try {
        const data = await res.json();
        if (data.data?.products?.length) {
          apiUrl = url;
          apiHeaders = res.request().headers();
          apiProducts = data.data.products;
          console.log(`  📡 Перехвачено: ${apiProducts.length} товаров`);
        }
      } catch (e) {}
    }
  });
  
  await page.goto('https://www.wildberries.ru/promotions/bally-za-otzyvy', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  
  await new Promise(r => setTimeout(r, 10000));
  
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1000));
    await new Promise(r => setTimeout(r, 2000));
  }
  
  await browser.close();
  
  console.log(`\n💡 Память после браузера: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB\n`);
  
  if (apiProducts.length === 0) {
    console.log('❌ Товары не получены');
    return;
  }
  
  // Сохраняем заголовки для будущего использования
  fs.writeFileSync(path.join(__dirname, 'api-headers.json'), JSON.stringify({
    url: apiUrl,
    headers: apiHeaders
  }, null, 2));
  
  // Парсим товары
  const products = apiProducts.map(p => {
    let price = 0, salePrice = 0;
    if (p.sizes?.[0]?.price) {
      price = Math.floor((p.sizes[0].price.basic || 0) / 100);
      salePrice = Math.floor((p.sizes[0].price.product || 0) / 100);
    } else if (p.priceU) {
      price = Math.floor(p.priceU / 100);
      salePrice = p.salePriceU ? Math.floor(p.salePriceU / 100) : 0;
    } else {
      price = p.price || 0;
    }
    
    return {
      wb_id: p.id || p.nmId,
      name: p.name || '',
      price,
      sale_price: salePrice,
      feedback_points: p.feedbackPoints || 0,
      brand: p.brand || '',
      seller: p.supplier || '',
      review_rating: p.reviewRating || p.rating || 0,
      feedbacks: p.feedbacks || p.nmFeedbacks || 0,
      url: `https://www.wildberries.ru/catalog/${p.id || p.nmId}/detail.aspx`
    };
  });
  
  // Сохранение
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO products 
    (wb_id, name, price, sale_price, feedback_points, brand, seller, review_rating, feedbacks, url, found_at)
    VALUES (@wb_id, @name, @price, @sale_price, @feedback_points, @brand, @seller, @review_rating, @feedbacks, @url, datetime('now'))
  `);
  db.transaction(prods => prods.forEach(p => stmt.run(p)))(products);
  
  fs.writeFileSync(path.join(__dirname, 'products-light.json'), JSON.stringify(products, null, 2));
  
  console.log(`💾 Сохранено: ${products.length} товаров`);
  
  // Итоги
  console.log('\n' + '='.repeat(60));
  console.log(`📊 ${products.length} товаров | ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
  
  console.log('\n📦 Примеры:\n');
  products.slice(0, 5).forEach((p, i) => {
    console.log(`   ${i+1}. ${p.name.substring(0, 40)}...`);
    console.log(`      💰 ${p.sale_price || p.price}₽ | 🎁 ${p.feedback_points} баллов\n`);
  });
  
  console.log('✨ Готово!\n');
}

main().catch(console.error);
