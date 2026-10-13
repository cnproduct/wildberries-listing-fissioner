"""Build an existing-card update without dropping unrelated editable fields.

WB replaces card data on update. Callers must fetch a fresh snapshot, review
facts and archive the exact payload before submitting it. This module performs
no network writes and cannot certify factual truth or storefront visibility.
"""
from copy import deepcopy
import math

EDITABLE = ('nmID', 'vendorCode', 'title', 'description', 'brand', 'dimensions',
            'characteristics', 'sizes', 'kizMarked', 'wholesale')
DETAIL_FIELDS = {'title', 'description', 'brand', 'characteristics'}


def normalize_characteristics(values):
    if not isinstance(values, list):
        raise ValueError('Characteristics must be a list')
    result = {}
    for item in values:
        cid, value = item.get('id'), item.get('value')
        if isinstance(cid, bool) or not isinstance(cid, int) or cid <= 0 or cid in result:
            raise ValueError('Invalid or duplicate characteristic ID')
        if isinstance(value, list):
            if not value or any(not isinstance(v, str) or not v.strip() for v in value):
                raise ValueError('Invalid characteristic text')
        elif isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError('Invalid characteristic number')
        result[cid] = deepcopy(value)
    return result


def build_detail_update(card, changes, *, removed_characteristic_ids=()):
    if not changes or set(changes) - DETAIL_FIELDS:
        raise ValueError('Only reviewed detail fields can be changed')
    if (isinstance(card.get('nmID'), bool) or not isinstance(card.get('nmID'), int)
            or card['nmID'] <= 0 or not card.get('vendorCode') or not card.get('sizes')
            or not isinstance(card.get('dimensions'), dict)):
        raise ValueError('Fresh complete existing card required')
    result = {k: deepcopy(card[k]) for k in EDITABLE if k in card}
    result.update(deepcopy(changes))
    for key, limit in (('title', 60), ('description', 5000), ('brand', 255)):
        value = result.get(key)
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            raise ValueError('Missing or invalid ' + key)
    before = normalize_characteristics(card.get('characteristics', []))
    after = normalize_characteristics(result.get('characteristics', []))
    if set(before) - set(after) != set(removed_characteristic_ids):
        raise ValueError('Attribute removals must be reviewed explicitly')
    result['characteristics'] = [{'id': cid, 'value': value} for cid, value in after.items()]
    # isValid is a read-only field in the list response, not an update parameter.
    result['dimensions'].pop('isValid', None)
    return result


def verify_detail_readback(expected, actual):
    """Return mismatches, including accidental identity/size/dimension changes."""
    issues = []
    for key in ('nmID', 'vendorCode', 'brand', 'title', 'description', 'kizMarked', 'wholesale'):
        if key in expected and actual.get(key) != expected[key]:
            issues.append(key + '_mismatch')
    if normalize_characteristics(expected['characteristics']) != normalize_characteristics(actual.get('characteristics', [])):
        issues.append('characteristics_mismatch')
    for key, value in expected['dimensions'].items():
        if actual.get('dimensions', {}).get(key) != value:
            issues.append('dimension_' + key + '_mismatch')
    def sizes(rows):
        return sorted((s.get('chrtID'), s.get('techSize', ''), s.get('wbSize', ''), tuple(sorted(s.get('skus', [])))) for s in rows)
    if sizes(expected['sizes']) != sizes(actual.get('sizes', [])):
        issues.append('sizes_or_barcodes_mismatch')
    return issues
