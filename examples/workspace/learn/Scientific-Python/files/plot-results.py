# Synthetic learning example; no external data.
import csv
from pathlib import Path

with Path(__file__).with_name("radius-sensitivity.csv").open(newline="") as source:
    rows = list(csv.DictReader(source))
print([(row["radius"], row["weighted_loss"]) for row in rows])
