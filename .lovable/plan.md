# Step 1: populate the device tables

Scope this first pass to hardware only. Software, custom code, and grant links come later.

## What we have to work with

The registry has 174 entries. Only 35 of them are actual hardware:

- 28 `device` (Neuropixels, EmotiBit, Tobii Pro, Delsys Trigno, OptiTrack, Xsens, BIOPAC, Basler, FLIR, GoPro, Garmin, Avisoft, Shimmer3 GSR+, ...)
- 6 `clinical_instrument` (ADOS, SCQ, SRS, Leiter-3, PPVT, BOT-3)
- 1 `hybrid` (Motek CAREN)

Separately, 92 entries are `category_label` - plain modality names like "Scalp EEG", "Eye tracking", "Accelerometers", "Thermocam". Those are not devices; they are the category vocabulary.

The three device tables are currently empty, and the Devices page builds its 32-category taxonomy from a hardcoded array in `src/pages/Devices.tsx`.

## The three-table split

```text
device_manufacturers   who makes it        Empatica, Tobii, Delsys, IMEC, Motek
        |
        v
device_models          the actual product  EmbracePlus, Tobii Pro Glasses, Trigno, Neuropixels 1.0
        |
        v
device_categories      the modality        eda, eye_tracking, emg, ephys_probe
```

One row per real product in `device_models`, its maker in `device_manufacturers`, and the modality it measures in `device_categories`. That is the whole model for this step.

## Field-by-field mapping

`device_manufacturers` - derived from each entry's `maintainer` block:

| Column | Source |
| --- | --- |
| `name` | `maintainer.name` (Empatica, Tobii, Delsys) |
| `homepage_url` | `maintainer.url` |
| `aliases` | alias_index entries that resolve to this maker |
| `notes` | `maintainer.type` (company / academic lab / open-source project) |

`device_models` - one row per hardware entry:

| Column | Source |
| --- | --- |
| `model_name` | `display_name` |
| `manufacturer_id` | FK to the row created above |
| `device_class` | canonical category key, matched from `function` + aliases |
| `product_url` | `docs.primary` |
| `manual_urls` | `docs.install`, plus any other doc URLs |
| `aliases` | every `alias_index` key pointing at this `tool_id` |
| `output_signals` | parsed from `function` (EDA, PPG, temperature, IMU) |
| `sampling_rate_hz` | left null unless the entry states it |
| `regulatory_class` | set for the medical devices (EmbracePlus, NeuroPace RNS, Medtronic Percept) |

`device_categories` - built from the 92 category labels, deduplicated and folded onto the existing 32-key taxonomy:

| Column | Source |
| --- | --- |
| `key` | canonical key (`eda`, `eye_tracker`, `emg`) |
| `label` | human label ("Electrodermal Activity") |
| `description` | short definition |
| `measures` | the signals it captures |

Deduplication matters: "Acoustic recording" / "Acoustic" / "Microphones" are one category, not three. The alias index already encodes most of these collapses.

No verification or status columns. If a field is unknown it stays null.

## How the data gets in

A one-time seed rather than a pipeline, since this is a fixed file:

1. Commit the registry to `public/tool_device_registry.json`.
2. Generate SQL from the 35 hardware entries and run it as a data insert - manufacturers first, then categories, then models with their FKs resolved.
3. Everything keys on natural unique values (`device_manufacturers.name`, `device_categories.key`, `device_models.model_name` + manufacturer), so re-running updates rather than duplicates.

The 35 rows are small enough to inspect by hand before they land, which beats debugging an edge function on a one-shot import.

## What you see afterwards

The Devices page reads `device_models` joined to `device_manufacturers` and `device_categories` instead of its hardcoded taxonomy: real product names, real makers, working links to product pages and manuals, and category filters that come from the data.

## Next steps, once this looks right

- The 35 software tools into `software_tools`.
- Prerequisites, install methods, and troubleshooting Q&A as child rows on each tool.
- Grant links, which need `grant_project_info_enriched.csv` - it was not uploaded, and without it nothing can connect a device to a specific BBQS project.
