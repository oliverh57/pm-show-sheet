"""Check dry-run request files against the API schemas bundled with google-api-python-client.

    python cli.py dry-run && python validate_requests.py
"""
import json
import pathlib
import sys

import googleapiclient

DOCS = pathlib.Path(googleapiclient.__file__).parent / "discovery_cache" / "documents"
OUT = pathlib.Path(__file__).parent / "out"


def check(obj, schema, schemas, path, errors):
    if "$ref" in schema:
        schema = schemas[schema["$ref"]]
    kind = schema.get("type")
    if kind == "object" and "properties" in schema:
        if not isinstance(obj, dict):
            errors.append(f"{path}: expected object")
            return
        for k, v in obj.items():
            if k not in schema["properties"]:
                errors.append(f"{path}.{k}: unknown field")
            else:
                check(v, schema["properties"][k], schemas, f"{path}.{k}", errors)
    elif kind == "array":
        for i, v in enumerate(obj):
            check(v, schema["items"], schemas, f"{path}[{i}]", errors)
    elif "enum" in schema and obj not in schema["enum"]:
        errors.append(f"{path}: {obj!r} not in enum")


failed = False
for api, file in (("sheets.v4", "requests.json"), ("slides.v1", "slides_requests.json")):
    schemas = json.loads((DOCS / f"{api}.json").read_text())["schemas"]
    reqs = json.loads((OUT / file).read_text())["requests"]
    errors = []
    for i, r in enumerate(reqs):
        check(r, {"$ref": "Request"}, schemas, f"requests[{i}]", errors)
    print(f"{api}: {len(reqs)} requests, {len(errors)} schema errors")
    for e in errors[:20]:
        print("  ", e)
    failed |= bool(errors)
sys.exit(1 if failed else 0)
