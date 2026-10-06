# SOSA layer: what the consortium's sensors observe, and on whom

The core graph already holds **device models** (`bbqs:Device`: "Pupil Labs eye trackers", made by
Pupil Labs GmbH, in the Eye Tracker category). It does not say **which project uses which device,
what that device measures, or on which subjects**. That is the job of the W3C
[SOSA/SSN](https://www.w3.org/TR/vocab-ssn/) ontology ([Janowicz et al. 2018](https://arxiv.org/abs/1805.09979)),
and the workshop's Appendix A sensor and device registry is the first dataset that carries it.

This directory is **phase S0**: the registry staged as data, a SOSA mapping, shapes that keep it
consistent, and the plan for moving it into the database and exporter. Nothing on the site reads
it yet, and nothing should (Principle XI: rendered data comes from the KG, not a checked-in copy).

## The SOSA model, mapped onto the registry

SOSA's centre is the **observation triangle**: a *Sensor* `observes` an *ObservableProperty*, which
is a property of a *FeatureOfInterest*. An *Observation* is one act of observing. It is
`madeBySensor` that sensor, has an `observedProperty` and a `hasFeatureOfInterest`, and yields a
*Result*.

```
                   bbqs:Project ◀── bbqs:on_project ── ssn:Deployment ── bbqs:deployment_foi ──▶ sosa:FeatureOfInterest
                   (grant, core graph)                    │                                     ("study subjects of R61MH135109")
                                                          │ ssn:deployedSystem                    │ bbqs:studies_species ──▶ bbqs:Species
                                                          ▼                                       │ ssn:hasProperty
 bbqs:Device ◀── bbqs:device_model ── sosa:Platform ── sosa:hosts ──▶ sosa:Sensor ── sosa:observes ──▶ sosa:ObservableProperty
 ("EmotiBit")                         ("EmotiBit @ Utah")              ("EmotiBit – EDA")             ("skin_conductance")
                                                                                                         │ bbqs:aligns_category
                                                                                                         ▼
                                                                                                 bbqs:DeviceCategory ("eda")
 S4, later:  sosa:Observation ── sosa:madeBySensor / sosa:observedProperty / sosa:hasFeatureOfInterest / sosa:hasResult ──▶ dataset
```

| Registry column | SOSA/SSN term | Notes |
|---|---|---|
| Device (as named) | `sosa:Sensor` or `sosa:Platform`, one per (device, award) | Rigs that record several modalities (EmotiBit, Social Interaction Suite, CAREN) are **platforms**. Each one hosts one sensor per property, so S4 observations attach to the right modality. NeuroPace RNS is also a `sosa:Actuator` (`ssn:forProperty` responsive stimulation). |
| Award | `ssn:Deployment` → `bbqs:on_project` → the grant's `bbqs:Project` | One deployment per grant. How the place name was resolved is kept in `bbqs:grant_match` (below). |
| Measures | `sosa:observes` → `sosa:ObservableProperty` | Free text normalized to the 52-key vocabulary in `observable_properties.csv`, each aligned to an existing `DeviceCategory` and its `measures` value where one exists. The original text is kept in `bbqs:measures_recorded`. |
| (implicit) whose body | `sosa:FeatureOfInterest`, `ssn:hasProperty` the observed properties | The project's study subjects, linked to the project's species, and their environment where the property is environmental (water flow). |
| Manufacturer (HQ), Model | `bbqs:device_model` → existing `bbqs:Device`, plus `bbqs:model_recorded` / `bbqs:manufacturer_recorded` | 33 of 60 rows link to a Device already in the graph. `bbqs:model_status` says how the model is known: `compiled` (from vendor sources, not the deck), `inferred`, `candidates`, `custom`, `unspecified`. |
| Spoke to it | `bbqs:presenter_role`, `bbqs:presenter_present` | Rows marked "no rep" are `presenter_present false` and must carry a `bbqs:verify_note`. Shape S-8 enforces this. |
| (source) | `prov:wasDerivedFrom` the Appendix A source node | Lets S5 replace "said at the workshop" with "confirmed by the PI" without losing history. |

Run the layer against the committed export and it already answers "which projects measure skin
conductance, with what, on which species":

```
R34DA059716 | Plethysmograph + EDA       | Human | BIOPAC, Shimmer3 GSR+
R61MH135106 | Biopac                     | Human | BIOPAC
R61MH135109 | EmotiBit                   | Human | EmotiBit
R61MH135405 | Wearable (EmbracePlus)     | Human | Empatica EmbracePlus
R61MH135407 | Custom skin-like wearable  | Human | (custom)
R61MH138705 | Social Interaction Suite   | Human | (in-house)
R61MH138713 | GSR (Shimmer3 / iMotions)  | Human | Shimmer3 GSR+
```

## What is in this directory

| File | What |
|---|---|
| `workshop_sensor_registry.csv` | Appendix A, one row per (device, award). 51 table rows become 60 here, because rows that named several awards are split. **Staging only.** S2 loads it into Supabase and deletes it. |
| `observable_properties.csv`, `actuatable_properties.csv` | The property vocabulary. |
| `build_sosa.py` | CSVs + `kg/export/bbqs.ttl` → `workshop_sensors.sosa.ttl`. Resolves grants by `grant_number` and devices by `name` at build time, so no UUIDs are hard-coded. `--check` runs the gate. |
| `sosa.shapes.ttl` | 9 SHACL shapes (S-1 … S-9): the triangle closes, every system is deployed, project and `grant_match` agree, provenance is present, unconfirmed rows are flagged, device links resolve. |
| `fixtures/{clean,contradictions}.ttl` | GREEN and RED fixtures, the same contract as `kg/shapes/`: every shape fires on RED, and GREEN conforms. |
| `workshop_sensors.sosa.ttl` | The built layer: 1,818 triples covering 25 deployments, 15 platforms, 97 sensors, 2 actuators, 52 properties and 26 features of interest. |

```bash
pip install -r kg/requirements.txt
python kg/sosa/build_sosa.py --check
```

CI runs the same command in the `kg` job.

## Decisions taken here (push back on any of them)

1. **Sensors are per (device, award), not per physical unit.** The registry has no serial numbers.
   A `sosa:Sensor` here means "this project's Pupil Labs glasses". If labs later register units,
   those become sub-systems (`ssn:hasSubSystem`) and nothing above them changes.
2. **SOSA predicates are emitted as SOSA IRIs**, while the core exporter writes `bbqs:<slot>`
   (issue #422). Interoperability is the whole point of SOSA, so a `bbqs:observes` alias would
   defeat it. When #422 settles the convention, the `bbqs:` helper predicates here follow it.
3. **The feature of interest is the project's study subjects**, linked to species, not to
   individual participants. Per-subject features belong to S4 and come from dataset metadata
   (NWB `Subject`), where they are de-identified at the source.
4. **The model is linked, not re-asserted.** Manufacturer and HQ already live on the `Device` and
   `DeviceManufacturer` nodes. The registry's values are kept as `*_recorded` literals, so a
   disagreement is visible rather than silently overwritten. Example: the KG says EmotiBit is made
   by Connected Future Labs, while the record says it is sold "via OpenBCI".
5. **People.** This repo is public and the committed export is anon-only, which hides investigator
   names. So the staged CSV names **PIs only**, who are already public on NIH RePORTER. Students,
   postdocs and co-Is appear as a role and lab ("Postdoc, Suthana lab"). This is especially true of
   the four names the notes marked VERIFY: guessed identities of students do not belong in a public
   file. Their names go into the S2 table under RLS, and a presenter becomes a link to an
   `Investigator` only once confirmed.

## Awards the build could not resolve with confidence

`grant_match` counts: 39 `pi_roster` (the presenter or lab is a named lead), 11 `institution`
(only one BBQS grant at that place), 1 `stated`, 1 `title`, 6 `ambiguous`, 2 `unresolved`.
These nine need a human:

| Rows | Award as named | Chosen | Why it's uncertain |
|---|---|---|---|
| A04 | Duke/Dunn | R34DA059506 | Dunn leads both 059506 and 059512, and a separate row says "Duke 059512" |
| A15, A17 | Georgia Tech (White Matter e3, PIT tags) | R34DA059510 | Two Georgia Tech grants. PIT tags fit the cichlid grant; R61MH138966 is Rozell's |
| A16, A20, A22 | NYU/Sanes | R34DA059513 | Sanes leads both R34DA059513 and U01DA063581 |
| A44 | Stony Brook | R61MH138612 | Matched by title (SeeMe); the roster lists no lead |
| A31, A59 | Pittsburgh | — | No roster grant has a Pittsburgh lead. R61MH138967 is a candidate by title only |

Also open: the Suthana-lab rows are filed under R61MH135106, which NIH lists at UCLA while the lab
presented as Duke. These are tagged in `grant_note`.

## The plan: from staged CSV to the pipeline

| Phase | What | Where it hooks into the pipeline | Status |
|---|---|---|---|
| **S0** | Stage Appendix A, property vocabulary, SOSA mapping, 9 shapes with RED/GREEN fixtures, CI step | Standalone. `build_sosa.py --check` in `kg.yml`; reads the committed export | **this PR** |
| **S1** | Schema: add `sosa`/`ssn` prefixes and the classes `SensorDeployment` (`ssn:Deployment`), `Sensor`, `Platform`, `Actuator`, `ObservableProperty`, `FeatureOfInterest`, `Observation` (with `class_uri`s to SOSA), plus the slots above, to `bbqs.linkml.yaml`. Regenerate `bbqs.owl.ttl` / `bbqs.shapes.gen.ttl` | `gen-owl` / `gen-shacl` drift check. The `kg-exporter-classes` guard then requires every class the exporter types to exist here | planned |
| **S2** | Database: `observable_properties` (vocabulary, `resource_id` on the spine), `sensor_deployments` (grant FK, `device_model_id` FK nullable, `label_as_named`, `presenter_investigator_id` nullable, `presenter_role`, `presenter_present`, `verify_note`, `grant_match`, `model_status`, `*_recorded`), and the join `sensor_deployment_properties`. The seed migration starts with `set_actor('migration:workshop_sensor_registry')`. RLS hides presenter names from anon. Add the Caracal and other missing commercial models to `device_models`. **Delete the CSVs.** | Supabase, the system of record (Principles III and X) | planned |
| **S3** | Exporter: `_export_sosa()` in `bbqs_kg.py` reads the S2 tables and emits exactly what `build_sosa.py` emits today. The diff against `workshop_sensors.sosa.ttl` is the acceptance test. Move `sosa.shapes.ttl` and the fixtures into `kg/shapes/` and `kg/fixtures/`. Add `observes` and `on_project` edges to the explorer. Answer CQ14 (project → device category, today "unmodeled") through `deployedSystem/device_model/device_category`. Add SOSA competency questions to `competency_questions.yaml`. Re-baseline | `export()` → `validate()` → `reason()` → explorer, in one run | planned |
| **S4** | Observations: mint `sosa:Observation` / `sosa:ObservationCollection` from dataset metadata (DANDI/NWB `devices`, `acquisition`, `Subject`), with `madeBySensor` resolved to the S3 sensor, `hasResult` the dataset, and `resultTime` the session date. The other direction too: `project_device_usage` (abstract-mined evidence) becomes `prov:wasDerivedFrom` evidence on deployments it agrees with, and a shape flags deployments it contradicts | Exporter plus a dataset harvester | planned |
| **S5** | Confirmation loop: PIs confirm or correct their rows (the Devices page, plus an MCP tool `confirm_sensor_deployment` modelled on `confirm_species_candidate`). Confirmed rows get `prov:wasAttributedTo` the PI, and `verify_note` clears. S-8 then tracks what is still unconfirmed, and the count goes into `quality.json` | App, agent and DB | planned |
| **Spec** | `spec.md` / `plan.md` / `tasks.md` / `qa-itinerary.md` under `../bbqs-agent/specs/` | Working agreement | planned |

An observation in S4 will look like this:

```turtle
bid:sosa/obs/<dandiset>/<session>/gaze a sosa:Observation ;
  sosa:madeBySensor        bid:sosa/system/R61MH135109/pupil-labs-glasses ;
  sosa:observedProperty    bid:sosa/property/gaze_position ;
  sosa:hasFeatureOfInterest bid:sosa/foi/R61MH135109/subject ;
  sosa:resultTime          "2026-03-04T10:00:00Z"^^xsd:dateTime ;
  sosa:hasResult           <https://dandiarchive.org/dandiset/...> .
```
