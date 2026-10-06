require('dotenv').config();
const express = require('express');
const { CanvasScraper } = require('./pwScraper');

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());
app.set('json spaces', 0);

app.post('/scrape', async (req, res) => {
  const { netid, password } = req.body || {};

  if (!netid || !password) {
    return res.status(400).send(JSON.stringify({
      error: "Missing netid or password in request body"
    }));
  }

  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const scraper = new CanvasScraper(netid, password);
      const courses = await scraper.scrapeCanvas();

      return res.status(200).send(JSON.stringify(courses));

    } catch (error) {
      lastError = error;

      if (error?.message?.includes("Login failed")) {
        return res.status(401).send(JSON.stringify({
          error: error.message
        }));
      }

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 750));
      }
    }
  }

  console.error("Scraping failed after retries:", lastError);
  return res.status(500).send(JSON.stringify({
    error: "Scraping failed",
    details: lastError?.message || String(lastError)
  }));
});

app.get('/', (_req, res) => {
  res.status(200).send('Blackboard Scraper is running');
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});