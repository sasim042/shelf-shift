#!/usr/bin/env python3
import csv
import json
import os
import re
import unicodedata
from collections import defaultdict, Counter
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
DEFAULT_DATA = BASE_DIR / "master_products_all_zips_harmonized.csv"
FALLBACK_DATA = BASE_DIR.parent / "master_products_all_zips_harmonized.csv"
LEGACY_DATA = BASE_DIR / "master_products_all_zips.csv"
LEGACY_FALLBACK = BASE_DIR.parent / "master_products_all_zips.csv"
if os.environ.get("SHELFSIGNAL_DATA"):
    DATA_PATH = Path(os.environ.get("SHELFSIGNAL_DATA"))
else:
    if DEFAULT_DATA.exists():
        DATA_PATH = DEFAULT_DATA
    elif FALLBACK_DATA.exists():
        DATA_PATH = FALLBACK_DATA
    elif LEGACY_DATA.exists():
        DATA_PATH = LEGACY_DATA
    else:
        DATA_PATH = LEGACY_FALLBACK
WEIGHTS_PATH = Path(os.environ.get("SHELFSIGNAL_WEIGHTS", BASE_DIR / "zip_weights.csv"))

PRICE_BINS = [
    (None, 5, "<$5"),
    (5, 10, "$5-10"),
    (10, 15, "$10-15"),
    (15, 20, "$15-20"),
    (20, 30, "$20-30"),
    (30, 50, "$30-50"),
    (50, None, "$50+"),
]

SUBCATEGORY_RULES = [
    ("Powders & Supplements", [
        "powder", "whey", "casein", "isolate", "concentrate", "mass gainer",
        "protein blend", "collagen", "pea protein", "plant protein", "supplement",
        "tub", "canister"
    ]),
    ("Ready-to-Drink Shakes", [
        "ready to drink", "rtd", "protein shake", "shake", "smoothie",
        "protein drink", "milkshake"
    ]),
    ("Protein Bars", ["protein bar", "bar"]),
    ("Yogurt & Dairy", ["yogurt", "yoghurt", "skyr", "kefir", "cottage", "cheese", "pudding", "curd"]),
    ("Cereal & Oats", ["cereal", "granola", "oats", "oatmeal", "muesli"]),
    ("Snacks", ["chips", "crisps", "cookie", "cookies", "bites", "balls", "puffs", "crackers", "nuts", "trail", "jerky", "meat stick", "sticks", "popcorn"]),
    ("Pasta & Grains", ["pasta", "mac", "noodles", "ramen", "rice", "quinoa"]),
    ("Meals & Frozen", ["frozen", "meal", "entree", "entrée", "pizza", "burrito", "sandwich", "wrap", "bowl", "breakfast", "lunchables"]),
    ("Drinks & Coffee", ["protein water", "water", "coffee", "latte", "espresso", "cafe", "energy", "hydration", "electrolyte"]),
    ("Accessories & Tools", ["shaker", "blender bottle", "mixing bottle", "scoop", "container"]),
]


def normalize_text(value: str) -> str:
    v = (value or "").strip().lower()
    v = unicodedata.normalize("NFKD", v)
    v = v.replace("’", "'")
    v = re.sub(r"[\u2010-\u2015]", "-", v)
    v = v.replace("&", " and ")
    v = re.sub(r"[^a-z0-9+]+", " ", v)
    v = re.sub(r"\s+", " ", v).strip()
    return v or "unknown"


def normalize_brand(value: str) -> str:
    return normalize_text(value)


def parse_price(value: str):
    if value is None:
        return None
    v = value.strip()
    if not v:
        return None
    v = v.replace("$", "").replace(",", "").strip()
    try:
        return float(v)
    except ValueError:
        return None


def parse_unit_count(pack_size: str, size: str, name: str):
    def extract(v):
        if not v:
            return None
        s = v.lower()
        # Explicit count keywords
        if any(k in s for k in ["ct", "count", "pack", "pk", "pcs", "pieces", "bottles", "bars", "cans", "cups", "pouches", "sticks", "servings"]):
            m = re.search(r"(\d+)", s)
            if not m:
                return None
            val = int(m.group(1))
            return val if val > 0 else None
        # Multipack pattern like "4 x 11 oz" or "4×11 oz"
        m = re.search(r"(\d+)\s*[x×]\s*\d+", s)
        if m:
            val = int(m.group(1))
            return val if val > 0 else None
        # "pack of 6" pattern
        m = re.search(r"pack\s+of\s+(\d+)", s)
        if m:
            val = int(m.group(1))
            return val if val > 0 else None
        return None
    return extract(pack_size) or extract(size) or extract(name)


def is_in_stock(value: str) -> bool:
    v = (value or "").lower()
    if "unavailable" in v or "out of stock" in v:
        return False
    return True


def infer_subcategory(name: str) -> str:
    n = normalize_text(name)
    # Special case: avoid classifying Barilla as bars
    if "barilla" in n or "pasta" in n or "mac" in n or "noodles" in n:
        return "Pasta & Grains"
    # Avoid false positives for accessories vs drinks
    if "shaker" in n or "blender bottle" in n or "mixing bottle" in n:
        return "Accessories & Tools"
    for label, keys in SUBCATEGORY_RULES:
        for k in keys:
            if k in n:
                # Avoid false positives for generic \"bar\" inside other words
                if label == "Protein Bars" and "bar" in k:
                    if re.search(r"\\bbar(s)?\\b", n):
                        return label
                    continue
                # Avoid classifying \"shake\" in words like \"shaker\"
                if label == "Ready-to-Drink Shakes" and "shake" in k and "shaker" in n:
                    continue
                return label
    return "Other"


def load_weights(zips):
    weights = {}
    provided_flags = {}
    if WEIGHTS_PATH.exists():
        with open(WEIGHTS_PATH, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                z = (row.get("zip") or "").strip()
                if not z:
                    continue
                pop = row.get("population")
                dens = row.get("density")
                try:
                    pop_v = float(pop) if pop not in (None, "") else None
                except ValueError:
                    pop_v = None
                try:
                    dens_v = float(dens) if dens not in (None, "") else None
                except ValueError:
                    dens_v = None
                provided = pop_v is not None and dens_v is not None and pop_v > 0 and dens_v > 0
                weight = (pop_v * dens_v) if provided else 1.0
                weights[z] = weight
                provided_flags[z] = provided
    # Ensure all zips have weights
    for z in zips:
        if z not in weights:
            weights[z] = 1.0
            provided_flags[z] = False
    weights_complete = all(provided_flags.get(z, False) for z in zips)
    return weights, provided_flags, weights_complete


def price_bin_label(price):
    for low, high, label in PRICE_BINS:
        if low is None and price < high:
            return label
        if high is None and price >= low:
            return label
        if low is not None and high is not None and low <= price < high:
            return label
    return "Unknown"


class DataStore:
    def __init__(self, path: Path):
        self.path = path
        self.data = None
        self.brand_store = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
        self.brand_store_price = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
        self.brand_store_stock = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
        self.brand_subcats = defaultdict(lambda: defaultdict(Counter))
        self._load()

    def _load(self):
        if not self.path.exists():
            raise FileNotFoundError(f"Data file not found: {self.path}")

        zips = defaultdict(lambda: {
            "stores": defaultdict(lambda: {"sk": 0, "brands": set(), "price_sum": 0.0, "price_n": 0, "stock": 0, "count": 0}),
            "brands": defaultdict(lambda: {"sk": 0, "stores": set(), "price_sum": 0.0, "price_n": 0, "stock": 0, "count": 0, "display": Counter()}),
            "pd": Counter(),
            "subcats": Counter(),
            "brand_subcats": defaultdict(Counter),
            "stores_set": set(),
            "brands_set": set(),
            "price_sum": 0.0,
            "price_n": 0,
            "unit_price_sum": 0.0,
            "unit_price_n": 0,
            "stock": 0,
            "count": 0,
            "label": Counter(),
        })

        meta_counts = {
            "rows_total": 0,
            "missing_upc": 0,
            "missing_pack_size": 0,
            "missing_size": 0,
            "missing_brand": 0,
            "unit_price_available": 0,
        }

        with open(self.path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                meta_counts["rows_total"] += 1
                zip_code = (row.get("zip") or "").strip()
                if not zip_code:
                    continue
                label = (row.get("address_label") or "").strip()
                if label:
                    zips[zip_code]["label"][label] += 1
                store = (row.get("store_name") or "Unknown").strip() or "Unknown"
                brand_raw = (row.get("brand") or "").strip()
                if not brand_raw:
                    meta_counts["missing_brand"] += 1
                brand_norm = normalize_brand(brand_raw or "unknown")

                price_val = parse_price(row.get("sale_price") or "")
                if price_val is None:
                    price_val = parse_price(row.get("price") or "")
                unit_count = parse_unit_count(row.get("pack_size") or "", row.get("size") or "", row.get("name") or "")
                in_stock = is_in_stock(row.get("availability") or "")
                subcat = infer_subcategory(row.get("name") or "")

                if not (row.get("upc") or "").strip():
                    meta_counts["missing_upc"] += 1
                if not (row.get("pack_size") or "").strip():
                    meta_counts["missing_pack_size"] += 1
                if not (row.get("size") or "").strip():
                    meta_counts["missing_size"] += 1

                z = zips[zip_code]
                z["count"] += 1
                z["stores_set"].add(store)
                z["brands_set"].add(brand_norm)

                z_store = z["stores"][store]
                z_store["sk"] += 1
                z_store["brands"].add(brand_norm)
                z_store["count"] += 1
                if in_stock:
                    z_store["stock"] += 1

                z_brand = z["brands"][brand_norm]
                z_brand["sk"] += 1
                z_brand["stores"].add(store)
                z_brand["count"] += 1
                if in_stock:
                    z_brand["stock"] += 1
                z_brand["display"][brand_raw or "Unknown"] += 1

                if price_val is not None:
                    z["price_sum"] += price_val
                    z["price_n"] += 1
                    z_store["price_sum"] += price_val
                    z_store["price_n"] += 1
                    z_brand["price_sum"] += price_val
                    z_brand["price_n"] += 1
                    z["pd"][price_bin_label(price_val)] += 1
                    if unit_count and unit_count > 0:
                        unit_price = price_val / unit_count
                        z["unit_price_sum"] += unit_price
                        z["unit_price_n"] += 1
                        meta_counts["unit_price_available"] += 1
                        z_store.setdefault("unit_price_sum", 0.0)
                        z_store.setdefault("unit_price_n", 0)
                        z_store["unit_price_sum"] += unit_price
                        z_store["unit_price_n"] += 1
                        z_brand.setdefault("unit_price_sum", 0.0)
                        z_brand.setdefault("unit_price_n", 0)
                        z_brand["unit_price_sum"] += unit_price
                        z_brand["unit_price_n"] += 1

                if in_stock:
                    z["stock"] += 1

                z["subcats"][subcat] += 1
                z["brand_subcats"][brand_norm][subcat] += 1
                self.brand_subcats[zip_code][brand_norm][subcat] += 1

                # Brand-store mapping for tailored insights
                self.brand_store[zip_code][brand_norm][store] += 1
                if price_val is not None:
                    self.brand_store_price[zip_code][brand_norm][store].append(price_val)
                self.brand_store_stock[zip_code][brand_norm][store].append(1 if in_stock else 0)

        zip_list = sorted(zips.keys())
        weights, provided_flags, weights_complete = load_weights(zip_list)

        zip_labels = {}
        for z in zip_list:
            label_counter = zips[z]["label"]
            zip_labels[z] = label_counter.most_common(1)[0][0] if label_counter else z

        # Build per-zip summaries
        z_summary = {}
        for z in zip_list:
            zd = zips[z]
            ts = len(zd["stores_set"])
            sk = zd["count"]
            br = len(zd["brands_set"])
            ap = (zd["price_sum"] / zd["price_n"]) if zd["price_n"] else 0.0
            pp = (zd["unit_price_sum"] / zd["unit_price_n"]) if zd["unit_price_n"] else 0.0
            ir = (zd["stock"] / zd["count"] * 100.0) if zd["count"] else 0.0

            # HHI based on SKU share
            hhi = 0.0
            if sk:
                for bdata in zd["brands"].values():
                    share = bdata["sk"] / sk
                    hhi += share * share

            stores_list = []
            for store_name, sdata in zd["stores"].items():
                store_ap = (sdata["price_sum"] / sdata["price_n"]) if sdata["price_n"] else 0.0
                store_pp = (sdata.get("unit_price_sum", 0.0) / sdata.get("unit_price_n", 0)) if sdata.get("unit_price_n") else 0.0
                store_ir = (sdata["stock"] / sdata["count"] * 100.0) if sdata["count"] else 0.0
                stores_list.append({
                    "n": store_name,
                    "s": sdata["sk"],
                    "b": len(sdata["brands"]),
                    "ap": round(store_ap, 2),
                    "pp": round(store_pp, 2) if store_pp else 0.0,
                    "ir": round(store_ir, 1),
                })
            stores_list.sort(key=lambda x: x["s"], reverse=True)

            brands_list = []
            for bnorm, bdata in zd["brands"].items():
                display = bdata["display"].most_common(1)[0][0]
                ap_b = (bdata["price_sum"] / bdata["price_n"]) if bdata["price_n"] else 0.0
                pp_b = (bdata.get("unit_price_sum", 0.0) / bdata.get("unit_price_n", 0)) if bdata.get("unit_price_n") else 0.0
                sr = (bdata["stock"] / bdata["count"] * 100.0) if bdata["count"] else 0.0
                sc = len(bdata["stores"])
                penetration = (sc / ts * 100.0) if ts else 0.0
                brands_list.append({
                    "id": bnorm,
                    "n": display,
                    "sc": sc,
                    "sk": bdata["sk"],
                    "p": round(penetration, 1),
                    "ap": round(ap_b, 2),
                    "pp": round(pp_b, 2) if pp_b else 0.0,
                    "sr": round(sr, 1),
                })
            brands_list.sort(key=lambda x: x["sk"], reverse=True)

            # Price distribution bins in fixed order
            pd = {label: int(zd["pd"].get(label, 0)) for _, _, label in PRICE_BINS}

            z_summary[z] = {
                "label": zip_labels[z],
                "ts": ts,
                "sk": sk,
                "br": br,
                "ap": round(ap, 2),
                "pp": round(pp, 2),
                "ir": round(ir, 1),
                "hhi": round(hhi, 4),
                "pd": pd,
                "subcats": dict(zd["subcats"]),
                "stores": stores_list,
                "brands": brands_list,
            }

        # Cross-brand summaries
        cross = {}
        for z in zip_list:
            for b in z_summary[z]["brands"]:
                bid = b["id"]
                cross.setdefault(bid, {"avg": 0.0, "zips": {}})
                cross[bid]["zips"][z] = {
                    "p": b["p"],
                    "sk": b["sk"],
                    "sc": b["sc"],
                    "ts": z_summary[z]["ts"],
                    "n": b["n"],
                    "ap": b["ap"],
                    "pp": b["pp"],
                }

        # Weighted averages for brand penetration and price-per-item
        for bid, bdata in cross.items():
            num = 0.0
            den = 0.0
            pp_num = 0.0
            pp_den = 0.0
            for z in zip_list:
                w = weights.get(z, 1.0)
                p = bdata["zips"].get(z, {}).get("p", 0.0)
                num += p * w
                den += w
                pp = bdata["zips"].get(z, {}).get("pp", 0.0)
                if pp:
                    pp_num += pp * w
                    pp_den += w
            bdata["avg"] = round(num / den, 2) if den else 0.0
            bdata["avg_pp"] = round(pp_num / pp_den, 2) if pp_den else 0.0

        # Weighted national metrics
        def wavg(metric_key):
            num = 0.0
            den = 0.0
            for z in zip_list:
                w = weights.get(z, 1.0)
                num += z_summary[z][metric_key] * w
                den += w
            return round(num / den, 2) if den else 0.0
        def wavg_nonzero(metric_key):
            num = 0.0
            den = 0.0
            for z in zip_list:
                v = z_summary[z][metric_key]
                if not v:
                    continue
                w = weights.get(z, 1.0)
                num += v * w
                den += w
            return round(num / den, 2) if den else 0.0

        national = {
            "ts": wavg("ts"),
            "sk": wavg("sk"),
            "br": wavg("br"),
            "ap": wavg("ap"),
            "pp": wavg_nonzero("pp"),
            "ir": wavg("ir"),
            "hhi": wavg("hhi"),
        }

        weights_list = []
        for z in zip_list:
            weights_list.append({
                "zip": z,
                "label": zip_labels[z],
                "population": None,
                "density": None,
                "weight": round(weights.get(z, 1.0), 2),
                "provided": provided_flags.get(z, False),
            })

        # If weights CSV has more info, add it
        if WEIGHTS_PATH.exists():
            with open(WEIGHTS_PATH, newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                weight_map = {row.get("zip"): row for row in reader}
            for w in weights_list:
                row = weight_map.get(w["zip"])
                if row:
                    w["population"] = row.get("population")
                    w["density"] = row.get("density")

        meta = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source_file": str(self.path),
            "rows_total": meta_counts["rows_total"],
            "missing_upc": meta_counts["missing_upc"],
            "missing_pack_size": meta_counts["missing_pack_size"],
            "missing_size": meta_counts["missing_size"],
            "missing_brand": meta_counts["missing_brand"],
            "unit_price_available": meta_counts["unit_price_available"],
            "subcategory_rules": [label for label, _ in SUBCATEGORY_RULES] + ["Other"],
            "weights": weights_list,
            "weights_complete": weights_complete,
            "weight_formula": "weight = population × density",
            "national": national,
        }

        self.data = {
            "zips": z_summary,
            "cross": cross,
            "zip_list": zip_list,
            "zip_labels": zip_labels,
            "meta": meta,
        }

    def get_brand_insight(self, zip_code: str, brand: str):
        z = self.data["zips"].get(zip_code)
        if not z:
            return None
        brand_id = normalize_brand(brand)
        # map by id
        local_brand = None
        for b in z["brands"]:
            if b["id"] == brand_id:
                local_brand = b
                break
        cross = self.data["cross"].get(brand_id)
        if not cross:
            return None
        # Compute national averages for this brand
        zips_present = [zp for zp, val in cross["zips"].items() if val.get("sc", 0) > 0]
        avg_skus_where = 0.0
        if zips_present:
            avg_skus_where = sum(cross["zips"][zp]["sk"] for zp in zips_present) / len(zips_present)
        # zip rank by penetration
        ranked = sorted(
            ((zp, val.get("p", 0.0)) for zp, val in cross["zips"].items()),
            key=lambda x: x[1],
            reverse=True,
        )
        zip_rank = next((i + 1 for i, (zp, _) in enumerate(ranked) if zp == zip_code), None)
        # top stores in zip
        store_map = self.brand_store.get(zip_code, {}).get(brand_id, {})
        store_list = []
        for s, sk in store_map.items():
            prices = self.brand_store_price[zip_code][brand_id].get(s, [])
            stock_list = self.brand_store_stock[zip_code][brand_id].get(s, [])
            ap = sum(prices) / len(prices) if prices else 0.0
            sr = sum(stock_list) / len(stock_list) * 100 if stock_list else 0.0
            store_list.append({
                "store": s,
                "sk": sk,
                "ap": round(ap, 2),
                "sr": round(sr, 1),
            })
        store_list.sort(key=lambda x: x["sk"], reverse=True)

        total_stores = z["ts"]
        subcat_counts = self.brand_subcats[zip_code].get(brand_id, Counter())
        top_subcats = subcat_counts.most_common(5)
        if local_brand:
            local = {
                "stores": local_brand["sc"],
                "total_stores": total_stores,
                "penetration": local_brand["p"],
                "skus": local_brand["sk"],
                "avg_price": local_brand["ap"],
                "price_per_item": local_brand.get("pp", 0.0),
                "in_stock": local_brand["sr"],
            }
        else:
            local = {
                "stores": 0,
                "total_stores": total_stores,
                "penetration": 0.0,
                "skus": 0,
                "avg_price": 0.0,
                "price_per_item": 0.0,
                "in_stock": 0.0,
            }

        return {
            "brand_id": brand_id,
            "brand_label": (local_brand or cross["zips"].get(zip_code) or {}).get("n", brand),
            "zip": zip_code,
            "zip_label": self.data["zip_labels"].get(zip_code, zip_code),
            "local": local,
            "national": {
                "avg_penetration": cross["avg"],
                "avg_price_per_item": cross.get("avg_pp", 0.0),
                "avg_skus_where_present": round(avg_skus_where, 1),
                "zips_present": len(zips_present),
                "total_zips": len(self.data["zip_list"]),
            },
            "delta": {
                "penetration": round(local["penetration"] - cross["avg"], 1),
                "skus_vs_avg": round(local["skus"] - avg_skus_where, 1),
            },
            "rank": {
                "zip_rank_by_penetration": zip_rank,
                "total_zips": len(self.data["zip_list"]),
            },
            "subcategories": [{"name": n, "skus": c} for n, c in top_subcats],
            "top_stores": store_list[:8],
        }

    def get_store_insight(self, zip_code: str, store: str):
        z = self.data["zips"].get(zip_code)
        if not z:
            return None
        store_name = store
        store_data = next((s for s in z["stores"] if s["n"].lower() == store.lower()), None)
        if not store_data:
            return None
        # Find top brands in this store
        brand_counts = []
        for brand_id, stores in self.brand_store.get(zip_code, {}).items():
            if store_name in stores:
                brand_counts.append({
                    "brand": brand_id,
                    "sk": stores[store_name],
                })
        brand_counts.sort(key=lambda x: x["sk"], reverse=True)
        top_brands = brand_counts[:8]
        # Translate brand ids to display names
        display_map = {b["id"]: b["n"] for b in z["brands"]}
        for b in top_brands:
            b["brand"] = display_map.get(b["brand"], b["brand"])

        zip_avg_skus = sum(s["s"] for s in z["stores"]) / len(z["stores"]) if z["stores"] else 0
        zip_avg_brands = sum(s["b"] for s in z["stores"]) / len(z["stores"]) if z["stores"] else 0

        return {
            "zip": zip_code,
            "zip_label": self.data["zip_labels"].get(zip_code, zip_code),
            "store": store_data["n"],
            "store_stats": store_data,
            "zip_avg": {
                "skus": round(zip_avg_skus, 1),
                "brands": round(zip_avg_brands, 1),
            },
            "top_brands": top_brands,
        }


DATASTORE = DataStore(DATA_PATH)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def _send_json(self, data, status=200):
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/data":
            return self._send_json(DATASTORE.data)
        if parsed.path == "/api/brand":
            qs = parse_qs(parsed.query)
            z = (qs.get("zip") or [""])[0]
            brand = (qs.get("brand") or [""])[0]
            if not z or not brand:
                return self._send_json({"error": "zip and brand required"}, status=400)
            data = DATASTORE.get_brand_insight(z, brand)
            if not data:
                return self._send_json({"error": "brand not found"}, status=404)
            return self._send_json(data)
        if parsed.path == "/api/store":
            qs = parse_qs(parsed.query)
            z = (qs.get("zip") or [""])[0]
            store = (qs.get("store") or [""])[0]
            if not z or not store:
                return self._send_json({"error": "zip and store required"}, status=400)
            data = DATASTORE.get_store_insight(z, store)
            if not data:
                return self._send_json({"error": "store not found"}, status=404)
            return self._send_json(data)
        return super().do_GET()


def run():
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"ShelfSignal running on http://0.0.0.0:{port}")
    server.serve_forever()


if __name__ == "__main__":
    run()
