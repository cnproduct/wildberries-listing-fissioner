"""Explicit inventory assignment. User default is five per new listing.

Never run this as a periodic restock or as an image-visibility repair. Publishing
must invoke it once after selecting a real warehouse and resolving card sizes.
"""
DEFAULT_NEW_LISTING_STOCK = 5


def inventory_payload(cards, amount=DEFAULT_NEW_LISTING_STOCK):
    if isinstance(amount, bool) or not isinstance(amount, int) or amount < 0:
        raise ValueError('Stock must be a nonnegative integer')
    if not cards or len(cards) > 1000:
        raise ValueError('Provide 1 to 1000 exact cards')
    stocks, seen, products = [], set(), set()
    for card in cards:
        nm = card.get('nmID')
        if isinstance(nm, bool) or not isinstance(nm, int) or nm <= 0 or nm in products:
            raise ValueError('Unique existing product IDs required')
        products.add(nm)
        sizes = card.get('sizes') or []
        if len(sizes) != 1:
            raise ValueError('Multiple sizes require an explicit stock allocation; do not assign five to every size')
        cid = sizes[0].get('chrtID')
        if isinstance(cid, bool) or not isinstance(cid, int) or cid <= 0 or cid in seen:
            raise ValueError('Unique actual size IDs required')
        seen.add(cid)
        stocks.append({'chrtId': cid, 'amount': amount})
    return {'stocks': stocks}


def verify_inventory(payload, response):
    expected = {x['chrtId']: x['amount'] for x in payload['stocks']}
    rows = response.get('stocks', [])
    if not isinstance(rows,list) or any(type(x.get('chrtId')) is not int or type(x.get('amount')) is not int or x['amount']<0 for x in rows):
        return False
    actual = {x.get('chrtId'): x.get('amount') for x in rows}
    return len(actual) == len(rows) and all(actual.get(cid) == amount for cid, amount in expected.items())
