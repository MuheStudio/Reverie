"""W20 fixed static regions; identical arithmetic to the saved Claude review."""
import json
import sys
from PIL import Image, ImageChops, ImageStat


def compare(first, second):
    a = Image.open(first).convert("RGB")
    b = Image.open(second).convert("RGB")
    assert a.size == b.size == (2760, 1800)
    regions = []
    for name, box in [("books", (60, 1100, 400, 1200)),
                      ("floor-ring-left", (600, 1300, 900, 1470))]:
        difference = ImageChops.difference(a.crop(box), b.crop(box)).convert("L")
        regions.append(dict(name=name, box=box, mean=ImageStat.Stat(difference).mean[0]))
    return dict(imageSize=a.size, regions=regions)


if __name__ == "__main__":
    print(json.dumps(compare(sys.argv[1], sys.argv[2])))
