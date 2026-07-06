"""
Converte tutti gli shapefile STstats_<Comune>.shp in TopoJSON,
rimuovendo le colonne UHI_<anno> e arrotondando i valori numerici.

Struttura attesa (come da tua cartella Shapefile/):
    <input_dir>/
        STstats_Ancona/
            STstats_Ancona.shp  (+ .dbf .shx .prj .cpg)
        STstats_Aosta/
            STstats_Aosta.shp
        ...

Output:
    <output_dir>/
        STstats_Ancona.json   (TopoJSON con LST_2019..LST_2025 + P1/P14/P29 + id)
        STstats_Aosta.json
        ...

Requisiti:
    pip install pyshp topojson

Uso:
    python shape_to_topojson.py --input "C:\\Users\\Alex\\Dropbox\\Istat\\209_isole_calore_2026\\OUT\\Greenpeace\\Shapefile" --output "C:\\Users\\Alex\\Dropbox\\Istat\\209_isole_calore_2026\\app_aruba\\data"
"""

import os
import glob
import re
import argparse
import shapefile
import topojson as tp


DECIMALS = 3  # arrotondamento valori numerici (LST ecc.)


def clean_value(value, ndigits=DECIMALS):
    """Arrotonda float a ndigits, converte NaN in None, mantiene interi come interi."""
    if value is None:
        return None
    if isinstance(value, float):
        if value != value:  # NaN
            return None
        if value.is_integer():
            return int(value)
        return round(value, ndigits)
    return value


def read_shape_as_featurecollection(shp_path, drop_prefixes=("UHI_",)):
    """
    Legge lo shapefile con pyshp e ritorna una FeatureCollection GeoJSON,
    scartando i campi che iniziano con uno dei prefissi in drop_prefixes.
    """
    reader = shapefile.Reader(shp_path)
    field_names = [f[0] for f in reader.fields[1:]]  # salta il primo (DeletionFlag)
    keep_idx = [
        i for i, name in enumerate(field_names)
        if not any(name.startswith(p) for p in drop_prefixes)
    ]
    kept_names = [field_names[i] for i in keep_idx]

    features = []
    for sr in reader.shapeRecords():
        props = {name: clean_value(sr.record[i]) for i, name in zip(keep_idx, kept_names)}

        # Normalizza gli identificativi (evita che PRO_COM diventi 42002 senza zero iniziale)
        if "PRO_COM" in props and props["PRO_COM"] is not None:
            props["PRO_COM"] = str(int(props["PRO_COM"])).zfill(6)
        if "SEZ21_ID" in props and props["SEZ21_ID"] is not None:
            props["SEZ21_ID"] = str(int(props["SEZ21_ID"]))
        if "SEZ21" in props and props["SEZ21"] is not None:
            props["SEZ21"] = int(props["SEZ21"])

        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": sr.shape.__geo_interface__,
        })

    reader.close()
    return {"type": "FeatureCollection", "features": features}


def convert_one(shp_path, out_dir):
    fc = read_shape_as_featurecollection(shp_path)

    # prequantize=1e5 riduce la precisione delle coordinate mantenendo qualita' visiva
    # sotto lo zoom cittadino; abbatte parecchio il peso del file.
    topo = tp.Topology(fc, prequantize=1e5, toposimplify=0)

    base = os.path.splitext(os.path.basename(shp_path))[0]  # STstats_Ancona
    out_path = os.path.join(out_dir, f"{base}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(topo.to_json())

    size_kb = os.path.getsize(out_path) / 1024
    return out_path, len(fc["features"]), size_kb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="cartella con sottocartelle STstats_<Comune>/")
    ap.add_argument("--output", default="data", help="cartella di output per i .json")
    args = ap.parse_args()

    os.makedirs(args.output, exist_ok=True)
    pattern = os.path.join(args.input, "STstats_*", "STstats_*.shp")
    shp_files = sorted(glob.glob(pattern))

    if not shp_files:
        print(f"Nessuno shapefile trovato con pattern:\n  {pattern}")
        return

    print(f"Trovati {len(shp_files)} shapefile.\n")
    for shp in shp_files:
        name = re.sub(r"^STstats_", "", os.path.splitext(os.path.basename(shp))[0])
        try:
            out, n_feat, kb = convert_one(shp, args.output)
            print(f"  {name:20s} -> {os.path.basename(out):32s}  {n_feat:6d} sezioni  {kb:8.1f} KB")
        except Exception as e:
            print(f"  {name:20s} ERRORE: {e}")

    print(f"\nOutput in: {os.path.abspath(args.output)}")


if __name__ == "__main__":
    main()
