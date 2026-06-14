#!/usr/bin/env python3
"""
gen.py -- synthetic electrical test-report generator for ingestion-accuracy eval.

DEV-ONLY tool. Its deps (reportlab, Pillow) are NOT part of the production
image; this lives next to the extractor only so the eval harness can shell to
run.py. Nothing here ships.

For each synthetic report it renders the SAME content at three difficulty tiers
so per-tier extraction accuracy is directly comparable:
  clean -- crisp born-digital PDF (real text layer; the PowerDB-export case)
  scan  -- rasterized + grayscale + slight skew + noise (a flatbed scan)
  photo -- rotation/perspective/blur/uneven lighting/JPEG (phone photo of paper)
Each PDF gets a matched <name>.gt.json ground-truth file (the data IS the label).

Stress variation built in: units alternate between unicode (MOhm as the omega
char, micro-ohm, degC) and ASCII spellings to test unit normalization; fonts and
layouts vary across reports.

Usage:  python gen.py --out <dir> --count 20 [--seed 1]
"""
import argparse, json, os, random
from reportlab.lib.pagesizes import LETTER
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from PIL import Image, ImageDraw, ImageFont

OHM = chr(0x3a9); MICRO = chr(0xb5); DEG = chr(0xb0)

WINFONTS = {
    "Arial":   r"C:\Windows\Fonts\arial.ttf",
    "Times":   r"C:\Windows\Fonts\times.ttf",
    "Calibri": r"C:\Windows\Fonts\calibri.ttf",
    "Verdana": r"C:\Windows\Fonts\verdana.ttf",
    "Courier": r"C:\Windows\Fonts\cour.ttf",
}

# measurementType -> (normalized unit the extractor emits, ascii spelling,
#                     lo, hi, limit, pass_is_ge)
SPECS = {
    "insulation_resistance": ("M" + OHM, "Mohm", 100, 6000, 100, True),
    "contact_resistance":    (MICRO + OHM, "uohm", 40, 600, 250, False),
    "winding_resistance":    ("m" + OHM, "mohm", 5, 80, 100, False),
}
MFRS = ["ABB", "Eaton", "Schneider", "Siemens", "GE", "Square D"]
PHASES = ["A", "B", "C"]


def sample_report(rng):
    mfr = rng.choice(MFRS)
    serial = "%s-%02d-%05d" % (rng.choice(["KPA", "TX", "SWG", "MV"]), rng.randint(1, 40), rng.randint(10000, 99999))
    fields = {
        "serialNumber": serial,
        "manufacturer": mfr,
        "model": rng.choice(["TX-2500", "VD4", "Masterpact", "Type-W", "SafeGear"]),
        "testDate": "2026-%02d-%02d" % (rng.randint(1, 12), rng.randint(1, 28)),
        "vendor": rng.choice(["ACME Electrical", "PowerTest Inc", "Volt Services"]),
        "techName": rng.choice(["J. Rivera", "M. Chen", "A. Patel", "D. Brooks"]),
    }
    # pick 1-2 measurement types, each across the 3 phases
    types = rng.sample(list(SPECS), k=rng.randint(1, 2))
    use_unicode = rng.random() < 0.5  # half the reports print unicode units, half ascii
    rows, meas = [], []
    for mt in types:
        norm_unit, ascii_unit, lo, hi, limit, ge = SPECS[mt]
        printed_unit = norm_unit if use_unicode else ascii_unit
        for ph in PHASES:
            val = round(rng.uniform(lo, hi), 1)
            passed = (val >= limit) if ge else (val <= limit)
            res = "PASS" if passed else "FAIL"
            rows.append(("%s Ph %s" % (mt.replace("_", " ").title(), ph), ph, "%.1f" % val, printed_unit, res))
            meas.append({
                "measurementType": mt, "phase": ph,
                "asFoundValue": val, "asFoundUnit": norm_unit,   # GT unit = NORMALIZED
                "passFail": "GREEN" if passed else "RED",
            })
    return {"fields": fields, "measurements": meas, "_rows": rows}


def _header_lines(f):
    return [
        "ELECTRICAL TEST REPORT",
        "Serial Number: %s" % f["serialNumber"],
        "Manufacturer: %s    Model: %s" % (f["manufacturer"], f["model"]),
        "Test Date: %s    Tested By: %s" % (f["testDate"], f["techName"]),
        "Vendor: %s" % f["vendor"],
    ]


def render_clean_pdf(report, path, font_name):
    try:
        pdfmetrics.registerFont(TTFont(font_name, WINFONTS[font_name]))
        fn = font_name
    except Exception:
        fn = "Helvetica"
    c = canvas.Canvas(path, pagesize=LETTER)
    w, h = LETTER
    y = h - 60
    c.setFont(fn, 14); c.drawString(54, y, _header_lines(report["fields"])[0]); y -= 26
    c.setFont(fn, 10)
    for line in _header_lines(report["fields"])[1:]:
        c.drawString(54, y, line); y -= 16
    y -= 10
    c.setFont(fn, 10)
    cols = [54, 230, 290, 380, 470]
    for label, x in zip(["Test", "Phase", "As-Found", "Unit", "Result"], cols):
        c.drawString(x, y, label)
    y -= 4; c.line(54, y, 540, y); y -= 16
    for (test, ph, val, unit, res) in report["_rows"]:
        for txt, x in zip([test, ph, val, unit, res], cols):
            c.drawString(x, y, txt)
        y -= 16
    c.showPage(); c.save()


def render_image(report, font_name, scale=2):
    W, H = 850 * scale, 1100 * scale
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    try:
        big = ImageFont.truetype(WINFONTS[font_name], 28 * scale)
        reg = ImageFont.truetype(WINFONTS[font_name], 18 * scale)
    except Exception:
        big = ImageFont.load_default(); reg = ImageFont.load_default()
    y = 60 * scale
    lines = _header_lines(report["fields"])
    d.text((54 * scale, y), lines[0], fill="black", font=big); y += 50 * scale
    for line in lines[1:]:
        d.text((54 * scale, y), line, fill="black", font=reg); y += 30 * scale
    y += 20 * scale
    cols = [c * scale for c in (54, 300, 380, 500, 640)]
    for label, x in zip(["Test", "Phase", "As-Found", "Unit", "Result"], cols):
        d.text((x, y), label, fill="black", font=reg)
    y += 34 * scale
    for (test, ph, val, unit, res) in report["_rows"]:
        for txt, x in zip([test, ph, val, unit, res], cols):
            d.text((x, y), txt, fill="black", font=reg)
        y += 30 * scale
    return img


def degrade(img, tier, rng):
    from PIL import ImageFilter, ImageEnhance
    if tier == "scan":
        img = img.convert("L").convert("RGB")
        img = img.rotate(rng.uniform(-1.5, 1.5), expand=False, fillcolor="white")
        px = img.load()
        import random as _r
        for _ in range(int(img.size[0] * img.size[1] * 0.002)):
            x = _r.randrange(img.size[0]); y = _r.randrange(img.size[1])
            g = _r.randint(0, 90); px[x, y] = (g, g, g)
        img = img.resize((img.size[0] // 2, img.size[1] // 2))
    elif tier == "photo":
        img = img.rotate(rng.uniform(-5, 5), expand=True, fillcolor="white")
        img = img.filter(ImageFilter.GaussianBlur(radius=1.2))
        img = ImageEnhance.Brightness(img).enhance(rng.uniform(0.75, 1.15))
        img = ImageEnhance.Contrast(img).enhance(rng.uniform(0.8, 1.05))
        # uneven lighting: darken one corner
        from PIL import Image as _I
        grad = _I.new("L", img.size, 0)
        gd = ImageDraw.Draw(grad)
        gd.ellipse([-img.size[0] // 3, -img.size[1] // 3, img.size[0], img.size[1]], fill=40)
        img = _I.composite(img, _I.new("RGB", img.size, (30, 30, 30)), _I.eval(grad, lambda v: 255 - v).point(lambda v: 255 if v < 120 else 255))
    return img


def image_to_pdf(img, path, rng=None, tier="scan"):
    if rng is not None:
        # JPEG round-trip to bake in compression artifacts before embedding
        import io
        q = 40 if tier == "photo" else 70
        buf = io.BytesIO(); img.convert("RGB").save(buf, "JPEG", quality=q); buf.seek(0)
        img = Image.open(buf)
    img.convert("RGB").save(path, "PDF", resolution=150)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--count", type=int, default=20)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    rng = random.Random(args.seed)
    fonts = list(WINFONTS)
    manifest = []
    for i in range(args.count):
        report = sample_report(rng)
        font = rng.choice(fonts)
        gt = {"fields": report["fields"], "measurements": report["measurements"]}
        base = os.path.join(args.out, "rpt%03d" % i)
        # clean
        render_clean_pdf(report, base + "_clean.pdf", font)
        # scan / photo from a rendered image
        img = render_image(report, font)
        imgs = {}
        for tier in ("scan", "photo"):
            di = degrade(img.copy(), tier, rng)
            di.convert("RGB").save(base + "_%s.jpg" % tier, "JPEG", quality=70)
            imgs[tier] = base + "_%s.jpg" % tier
            image_to_pdf(di, base + "_%s.pdf" % tier, rng=rng, tier=tier)
        for tier in ("clean", "scan", "photo"):
            with open(base + "_%s.gt.json" % tier, "w", encoding="utf-8") as fh:
                json.dump(gt, fh)
            manifest.append({"pdf": base + "_%s.pdf" % tier, "img": imgs.get(tier), "gt": base + "_%s.gt.json" % tier, "tier": tier, "font": font})
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    print("generated %d reports x 3 tiers = %d PDFs into %s" % (args.count, args.count * 3, args.out))


if __name__ == "__main__":
    main()