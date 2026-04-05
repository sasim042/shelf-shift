# ShelfSignal App

This is a local, self-hosted version of the ShelfSignal dashboard with a real backend and transparent, weighted metrics.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=YOUR_GITHUB_REPO_URL)

## What It Does
- Reads `/Users/sasim/Documents/master_products_all_zips.csv`
- Computes ZIP, brand, and store metrics
- Applies population × density weighting for all "national" averages
- Infers subcategories and price-per-item (pack-size heuristics)
- Serves a live UI at `http://127.0.0.1:8000`

## Run
```bash
cd /Users/sasim/Documents/shelfsignal_app
python3 server.py
```

## Data Sources
- Primary data: `master_products_all_zips.csv`
- Weights file: `zip_weights.csv`

## Weights
Populate `zip_weights.csv` with `population` and `density` (people per sq mile).
If weights are missing, the backend defaults weight to 1 and flags the UI.

## Endpoints
- `GET /api/data` — all computed metrics
- `GET /api/brand?zip=04240&brand=Quest` — tailored brand insight
- `GET /api/store?zip=04240&store=Target` — tailored retailer insight
