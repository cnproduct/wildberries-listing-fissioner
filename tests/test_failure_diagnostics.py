import json
import tempfile
import unittest
from pathlib import Path
from scripts.failure_diagnostics import failure_details, failure_summary


class DiagnosticTests(unittest.TestCase):
    def test_quality_failure_retains_progress_without_exposing_private_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);(p/'generated').mkdir()
            (p/'generator.err.log').write_text('private token SECRET\nSource consistency review failed after retries at image 3\n')
            for n in (1,2):
                (p/'generated'/f'{n:02d}-accepted.json').write_text(json.dumps({'review':{'passed':True,'issues':[]}}))
            (p/'generated'/'03-try1-review.json').write_text(json.dumps({'issues':['Camera angle is frontal','extra product unit','garbled text SECRET']}))
            d=failure_details(RuntimeError('Generation program failed; see its private diagnostics'),p)
            self.assertEqual(d['reason_code'],'image_quality_failed');self.assertEqual(d['completed'],2)
            self.assertEqual(d['failed_image'],3);self.assertIn('extra_product',d['issue_codes'])
            self.assertNotIn('SECRET',json.dumps(d));self.assertIn('2/10',failure_summary(d))
            self.assertEqual(failure_details(TimeoutError('network'),p)['reason_code'],'connection_failed')

    def test_unknown_exception_does_not_fabricate_or_echo_cause(self):
        d=failure_details(RuntimeError('api_token=SECRET'))
        self.assertEqual(d['reason_code'],'unknown_failure');self.assertNotIn('SECRET',json.dumps(d))

