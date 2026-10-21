"""Built-in pricing strategy for 10 fission listings.

Rules:
1. Base price (P_base) from the original provided listing serves as the median/anchor price.
2. Every one of the 10 listings MUST have a unique price (no duplicate prices).
3. Listings 1 to 5: prices increase by +1% to +15% relative to P_base.
   Default target ratios: +2%, +5%, +8%, +11%, +15%.
4. Listings 6 to 10: prices decrease by -1% to -10% relative to P_base.
   Default target ratios: -2%, -4%, -6%, -8%, -10%.
5. All prices are positive integer rubles.
6. Collision resolution: if small base prices produce duplicate rounded values,
   adjust dynamically by minimum integer increments while strictly preserving uniqueness.
7. Produces standard Wildberries Discounts & Prices API upload payload.
"""
import math

DEFAULT_UPPER_RATIOS = (0.02, 0.05, 0.08, 0.11, 0.15)
DEFAULT_LOWER_RATIOS = (-0.02, -0.04, -0.06, -0.08, -0.10)


def calculate_fission_prices(base_price, count=10, up_ratios=None, down_ratios=None):
    """Calculate 10 differentiated prices around base_price.

    Returns:
        List of dicts with keys:
            index (1..10), price (int RUB), delta_ratio (float),
            delta_percent (str), tier ('upper' or 'lower')
    """
    if isinstance(base_price, bool) or not isinstance(base_price, (int, float)) or not math.isfinite(base_price) or base_price <= 0:
        raise ValueError("Base price must be a real positive number")
    if count not in (5, 10):
        raise ValueError("Fission pricing strategy requires 5 or 10 listings")

    if count == 5:
        up_r = list(up_ratios if up_ratios is not None else (0.02, 0.05, 0.08))
        down_r = list(down_ratios if down_ratios is not None else (-0.02, -0.05))
        if len(up_r) != 3 or len(down_r) != 2:
            raise ValueError("For 5 listings, upper and lower ratio lists must have 3 and 2 elements")
    else:
        up_r = list(up_ratios if up_ratios is not None else DEFAULT_UPPER_RATIOS)
        down_r = list(down_ratios if down_ratios is not None else DEFAULT_LOWER_RATIOS)
        if len(up_r) != 5 or len(down_r) != 5:
            raise ValueError("Upper and lower ratio lists must each have 5 elements")
    if any(r < 0.01 or r > 0.15 for r in up_r):
        raise ValueError("Upper price ratios must be between +1% and +15%")
    if any(r > -0.01 or r < -0.10 for r in down_r):
        raise ValueError("Lower price ratios must be between -1% and -10%")

    base_int = round(base_price)

    # 1. Calculate upper tier listings (increases: +1% to +15%)
    up_items = []
    prev_up = base_int
    for idx, r in enumerate(up_r, 1):
        target = round(base_price * (1.0 + r))
        actual = max(target, prev_up + 1)
        prev_up = actual
        delta = (actual - base_price) / base_price
        up_items.append({
            "index": idx,
            "price": int(actual),
            "delta_ratio": round(delta, 4),
            "delta_percent": f"{delta:+.1%}",
            "tier": "upper"
        })

    # 2. Calculate lower tier listings (decreases: -1% to -10%)
    down_items = []
    prev_down = base_int
    for idx, r in enumerate(down_r, len(up_r) + 1):
        target = round(base_price * (1.0 + r))
        actual = min(target, prev_down - 1)
        if actual <= 0:
            actual = 1
        prev_down = actual
        delta = (actual - base_price) / base_price
        down_items.append({
            "index": idx,
            "price": int(actual),
            "delta_ratio": round(delta, 4),
            "delta_percent": f"{delta:+.1%}",
            "tier": "lower"
        })

    all_items = up_items + down_items
    prices = [item["price"] for item in all_items]

    # Enforce uniqueness
    if len(set(prices)) != count:
        # Fallback fine-tuning for extremely small base prices
        used = set()
        for item in all_items:
            while item["price"] in used or item["price"] == base_int:
                if item["tier"] == "upper":
                    item["price"] += 1
                else:
                    item["price"] = max(1, item["price"] - 1)
            used.add(item["price"])
            delta = (item["price"] - base_price) / base_price
            item["delta_ratio"] = round(delta, 4)
            item["delta_percent"] = f"{delta:+.1%}"

    return all_items


def get_fission_price_values(base_price):
    """Return just the 10 integer prices in order."""
    return [item["price"] for item in calculate_fission_prices(base_price)]


def extract_base_price_from_source(evidence):
    """Extract baseline ruble price from WB source product evidence if available."""
    if not isinstance(evidence, dict):
        return None
    product = evidence.get("product") or {}
    sizes = product.get("sizes") or []
    if sizes and isinstance(sizes, list):
        price_obj = sizes[0].get("price")
        if isinstance(price_obj, dict):
            # WB card.wb.ru prices are usually in kopecks (cents)
            for k in ("product", "total", "basic"):
                val = price_obj.get(k)
                if isinstance(val, (int, float)) and val > 0:
                    rub = val / 100 if val > 10000 else float(val)
                    if rub > 0:
                        return round(rub)
        elif isinstance(price_obj, (int, float)) and price_obj > 0:
            return round(price_obj)
    # Check root price
    root_price = evidence.get("price") or product.get("price")
    if isinstance(root_price, (int, float)) and root_price > 0:
        return round(root_price)
    return None


def build_wb_price_upload_payload(cards_or_nmids, prices=None, default_discount=None):
    """Construct WB Discounts & Prices API (/api/v2/upload/task) payload.

    Args:
        cards_or_nmids: List of nmIDs (int/str) or card dicts.
        prices: Optional list of 10 prices. If omitted, cards_or_nmids must have 'price'.
        default_discount: Optional discount percentage (0..100).
    """
    if not cards_or_nmids or len(cards_or_nmids) != 10:
        raise ValueError("Exactly 10 cards/nmIDs required for fission price task")

    data = []
    for idx, item in enumerate(cards_or_nmids):
        if isinstance(item, dict):
            nmid = item.get("nmID") or item.get("nmId") or item.get("id")
            p = item.get("price") if prices is None else prices[idx]
            disc = item.get("discount", default_discount)
        else:
            nmid = item
            if prices is None:
                raise ValueError("Prices list required when providing raw nmIDs")
            p = prices[idx]
            disc = default_discount

        if isinstance(p, dict):
            p = p.get("price")

        if isinstance(nmid, bool) or not str(nmid).isdigit() or int(nmid) <= 0:
            raise ValueError(f"Invalid nmID at index {idx}: {nmid}")
        if isinstance(p, bool) or not isinstance(p, (int, float)) or p <= 0:
            raise ValueError(f"Invalid price at index {idx}: {p}")

        entry = {"nmID": int(nmid), "price": int(round(p))}
        if disc is not None:
            if isinstance(disc, bool) or not isinstance(disc, (int, float)) or not (0 <= disc <= 100):
                raise ValueError("Discount must be between 0 and 100")
            entry["discount"] = int(round(disc))
        data.append(entry)

    price_set = {d["price"] for d in data}
    if len(price_set) != 10:
        raise ValueError("Every listing must have a unique price")

    return {"data": data}


def verify_fission_price_distribution(base_price, prices):
    """Verify that a list of 10 prices satisfies the fission pricing requirements."""
    if len(prices) != 10:
        return False, "Must contain exactly 10 prices"
    if len(set(prices)) != 10:
        return False, "Prices are not all unique"
    if any(p <= 0 or int(p) != p for p in prices):
        return False, "Prices must be positive integers"

    up = prices[:5]
    down = prices[5:]

    for idx, p in enumerate(up, 1):
        if p <= base_price:
            return False, f"Listing {idx} price ({p}) is not higher than base price ({base_price})"

    for idx, p in enumerate(down, 6):
        if p >= base_price:
            return False, f"Listing {idx} price ({p}) is not lower than base price ({base_price})"

    return True, "Valid fission pricing distribution"
