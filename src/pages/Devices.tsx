import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageMeta } from "@/components/PageMeta";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Network } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import "@/styles/ag-grid-theme.css";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileCardList } from "@/components/MobileCardList";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DeviceCatalog } from "@/components/devices/DeviceCatalog";
import { DeviceProjectMap } from "@/components/devices/DeviceProjectMap";

// Canonical BBQS device taxonomy — the 32 categories used across the program.
// The DB `device_class` values (video_tracking, ephys_headstage, …) are folded
// into these buckets client-side via `canonicalCategory()` below.
type CanonicalCategory = {
  key: string;
  label: string;
  aliases: string[]; // lowercase substrings to match against device_class / labels / model / manufacturer
};

const BBQS_TAXONOMY: CanonicalCategory[] = [
  { key: "video_cameras", label: "Video Cameras", aliases: ["video_tracking", "video tracking", "behavior camera", "video camera", "rgb camera"] },
  { key: "neuropixels", label: "Neuropixels", aliases: ["neuropixel", "silicon probe", "imec"] },
  { key: "thermal_cameras", label: "Thermal Cameras", aliases: ["thermal camera", "flir", "thermal imag"] },
  { key: "ultrasonic_microphones", label: "Ultrasonic Microphones", aliases: ["ultrasonic", "usv", "bioacoustic", "audio_recording", "microphone"] },
  { key: "rna_sequencing", label: "RNA Sequencing", aliases: ["rna-seq", "rna seq", "sequencing", "scrna", "transcriptom"] },
  { key: "heart_rate_sensors", label: "Heart Rate Sensors", aliases: ["heart rate", "ecg", "hrv", "polar"] },
  { key: "eye_tracker", label: "Eye Tracker", aliases: ["eye-track", "eye track", "tobii", "pupil labs", "gaze"] },
  { key: "infrared_cameras", label: "Infrared Cameras", aliases: ["infrared camera", "ir camera", "nir camera"] },
  { key: "wireless_neural", label: "Wireless Neural", aliases: ["wireless neural", "wireless recording", "telemetry", "ephys_headstage", "headstage"] },
  { key: "imu", label: "IMU", aliases: ["imu", "inertial"] },
  { key: "rfid", label: "RFID", aliases: ["rfid"] },
  { key: "respiration_sensors", label: "Respiration Sensors", aliases: ["respiration", "breathing belt", "resp belt"] },
  { key: "accelerometer", label: "Accelerometer", aliases: ["accelerometer", "actigraph", "wearable_actigraphy"] },
  { key: "eeg", label: "EEG", aliases: ["eeg", "scalp electrode"] },
  { key: "eda", label: "EDA", aliases: ["eda", "electrodermal", "gsr", "skin conductance"] },
  { key: "plethysmography", label: "Plethysmography (PPG)", aliases: ["plethysmograph", "ppg", "pulse oximet"] },
  { key: "intranasal_thermistor", label: "Intranasal Thermistor", aliases: ["thermistor", "nasal temperature"] },
  { key: "emg", label: "EMG", aliases: ["emg", "electromyograph"] },
  { key: "gps", label: "GPS", aliases: ["gps", "geoloc"] },
  { key: "neuroimaging_fmri", label: "Neuroimaging (fMRI)", aliases: ["fmri", "mri scanner", "neuroimaging"] },
  { key: "flow_sensors", label: "Flow Sensors", aliases: ["flow sensor", "airflow", "flowmeter"] },
  { key: "tracking_software", label: "Tracking Software", aliases: ["deeplabcut", "dlc", "sleap", "tracking software", "pose estimation"] },
  { key: "ieeg", label: "iEEG", aliases: ["ieeg", "ecog", "intracranial", "sEEG", "seeg", "stimulation"] },
  { key: "motion_tracking", label: "Motion Tracking", aliases: ["motion capture", "mocap", "vicon", "optitrack"] },
  { key: "cortisol_wearable", label: "Cortisol Wearable", aliases: ["cortisol"] },
  { key: "epinephrine_wearable", label: "Epinephrine Wearable", aliases: ["epinephrine", "adrenaline sensor"] },
  { key: "opm", label: "Optically Pumped Magnetometers", aliases: ["optically pumped", "opm", "magnetometer", "quspin"] },
  { key: "smartphone_camera", label: "Smartphone Camera", aliases: ["smartphone", "iphone", "mobile phone camera"] },
  { key: "skin_temperature", label: "Skin Temperature Sensor", aliases: ["skin temperature", "temperature sensor"] },
  { key: "vr", label: "Virtual Reality Environment", aliases: ["virtual reality", "vr headset", "oculus", "htc vive"] },
  { key: "lidar", label: "LiDAR", aliases: ["lidar"] },
  { key: "mmwave", label: "Millimeter Wave Sensing", aliases: ["millimeter wave", "mmwave", "60 ghz radar"] },
  // "Two-photon" and generic ephys headstages that don't fit above still get
  // surfaced under a catch-all so we don't silently drop rows.
  { key: "other", label: "Other / Unmapped", aliases: [] },
];

function canonicalCategory(r: DeviceRow): CanonicalCategory {
  const hay = [r.device_class, r.model_name, r.hardware_label, r.device_label, r.manufacturer, r.sample_use_case]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  for (const c of BBQS_TAXONOMY) {
    if (c.key === "other") continue;
    if (c.aliases.some((a) => hay.includes(a.toLowerCase()))) return c;
  }
  return BBQS_TAXONOMY[BBQS_TAXONOMY.length - 1];
}

// Common gotchas keyed by canonical taxonomy key.
const COMMON_ISSUES: Record<string, string[]> = {
  silicon_probe: [
    "Shank breakage on insertion — slow descent (<5 µm/s) and pre-thin dura",
    "Ground/reference loops causing 60 Hz noise",
    "Channel drift over long recordings; re-reference or Kilosort drift correction",
  ],
  miniscope: [
    "GRIN lens focal drift after implantation — re-focus at each session",
    "Photobleaching with high LED power; keep <0.3 mW/mm²",
    "Cable torque restricts natural behavior; use commutator",
  ],
  two_photon_microscope: [
    "Z-drift over long sessions — enable online motion correction",
    "Laser power creep damages tissue; monitor at objective",
    "PMT saturation in bright expressers",
  ],
  dbs_lead: [
    "Lead migration in first 2 weeks post-op",
    "Impedance changes as scar tissue forms",
    "Stim-induced side effects need re-programming",
  ],
  camera: [
    "Rolling shutter distorts fast movement — use global shutter for pose tracking",
    "IR illumination flicker synced to line frequency",
    "Frame drops at high FPS if disk I/O can't keep up",
  ],
  depth_camera: [
    "IR interference between multiple depth cameras — stagger or time-mux",
    "Poor depth on dark/reflective fur",
    "Calibration drift with temperature",
  ],
  headstage: [
    "Connector fatigue after ~50 mating cycles",
    "Static discharge kills channels — ground yourself",
    "SPI/serial timing issues at high channel counts",
  ],
  behavior_rig: [
    "Lick-spout capacitance drift over session",
    "Solenoid click cues the animal — mask with white noise",
    "Frame timing jitter breaks trial alignment",
  ],
  monitor: [
    "Refresh rate mismatch with stim software drops frames",
    "Gamma not calibrated → contrast unreliable across labs",
    "Backlight flicker aliases with camera FPS",
  ],
  injector: [
    "Air bubbles cause volume errors — bleed lines before use",
    "Backflow up the pipette track; use slow infusion + wait time",
    "Tip clogging with viscous vectors",
  ],
  optical_fiber: [
    "Coupling losses at rotary joint (~30%)",
    "Tissue damage from heating at >20 mW/mm²",
    "Fiber tip contamination reduces output over time",
  ],
  daq: [
    "Ground loops when chaining multiple DAQs",
    "Sample-clock drift between devices — use shared clock",
    "Buffer underruns at high channel × rate combinations",
  ],
  // Canonical BBQS taxonomy keys
  video_cameras: [
    "Rolling shutter distorts fast movement — use global shutter for pose tracking",
    "IR illumination flicker synced to line frequency",
    "Frame drops at high FPS if disk I/O can't keep up",
  ],
  neuropixels: [
    "Headstage overheating in freely-moving rigs — add airflow or duty-cycle",
    "Reference/ground mis-config produces flat channels",
    "Probe bending if not perfectly perpendicular to brain surface",
  ],
  thermal_cameras: [
    "Emissivity assumptions off for fur/skin — calibrate per subject",
    "Ambient temperature drift; re-baseline between sessions",
    "Low spatial resolution vs. RGB — align with a shared fiducial",
  ],
  ultrasonic_microphones: [
    "Aliasing if sample rate <2× target frequency (need >=250 kHz for mouse USV)",
    "Cage reflections cause phantom calls — use absorbing lining",
    "Wind/handling noise in the ultrasonic band",
  ],
  rna_sequencing: [
    "Batch effects across library prep days",
    "Low-input dropout in single-cell protocols",
    "Ambient RNA contamination in droplet workflows",
  ],
  heart_rate_sensors: [
    "Motion artifact during locomotion",
    "Poor contact on furred/dark skin",
    "Bluetooth dropouts break beat-to-beat continuity",
  ],
  eye_tracker: [
    "Drift over long sessions — re-calibrate every 10–15 min",
    "Glasses/eyelashes cause pupil detection loss",
    "Head-fixed vs. free-viewing latencies differ",
  ],
  infrared_cameras: [
    "IR illuminator hotspots saturate the sensor",
    "Multiple IR sources interfere — stagger or time-multiplex",
    "Focus shift between visible and IR",
  ],
  wireless_neural: [
    "RF dropouts in dense metal environments",
    "Battery life limits session length",
    "Sync jitter with wired streams — use hardware trigger",
  ],
  imu: [
    "Gyro drift over minutes; fuse with accelerometer/magnetometer",
    "Magnetometer useless indoors near ferrous metal",
    "Clock skew vs. other streams — use LSL for sync",
  ],
  rfid: [
    "Read range collapses near metal cage walls",
    "Tag collision when multiple animals cluster",
    "Antenna orientation strongly affects detection",
  ],
  respiration_sensors: [
    "Belt slippage over long sessions",
    "Motion artifact mimics breaths",
    "Baseline drift from posture changes",
  ],
  accelerometer: [
    "DC drift on cheap MEMS — high-pass filter",
    "Aliasing when downsampling gait data",
    "Axis-alignment errors between subjects",
  ],
  eeg: [
    "Impedance >10 kΩ → noisy channels; re-gel and re-abrade",
    "Line noise from nearby equipment; notch filter or shielding",
    "Sweat/movement artifacts in long recordings",
  ],
  eda: [
    "Sensor dries out — re-gel every ~30 min",
    "Temperature confounds tonic level",
    "Ambulatory motion swamps phasic peaks",
  ],
  plethysmography: [
    "Motion artifact dominates during exercise",
    "Skin tone bias for green-LED PPG",
    "Pressure of the finger clip alters waveform",
  ],
  intranasal_thermistor: [
    "Fixation drift with head movement",
    "Mouth-breathing bypasses the sensor",
    "Condensation shorts the bead",
  ],
  emg: [
    "Cross-talk between adjacent muscles",
    "Electrode lift-off during long sessions",
    "Motion artifact swamping signal at high forces",
  ],
  gps: [
    "Multipath error in urban canyons",
    "Indoor accuracy is effectively zero",
    "Cold-start fix delay of 30–60 s",
  ],
  neuroimaging_fmri: [
    "Motion regressors don't fully remove spike artifacts",
    "Physio noise (cardiac/respiratory) aliased into BOLD",
    "Distortion in orbitofrontal / temporal lobe near air",
  ],
  flow_sensors: [
    "Calibration drift with temperature",
    "Debris clogging small-bore sensors",
    "Reverse-flow detection missing on some hot-wire models",
  ],
  tracking_software: [
    "Model generalization fails across lighting/arena changes",
    "Occlusion causes ID swaps in multi-animal tracking",
    "Frame rate mismatch between labeled and inference video",
  ],
  ieeg: [
    "Grid migration between imaging and recording — re-localize",
    "CSF shunting under grid causing signal loss",
    "Stim artifact bleed into recording channels",
  ],
  motion_tracking: [
    "Marker occlusion in cluttered scenes",
    "IR strobe interference between cameras",
    "Calibration drift after rig bumps",
  ],
  cortisol_wearable: [
    "Sweat pooling delays diffusion to sensor",
    "Diurnal baseline swamps event-locked responses",
    "Sensor lifetime measured in hours, not days",
  ],
  epinephrine_wearable: [
    "Very short half-life narrows the detection window",
    "Cross-reactivity with other catecholamines",
    "Skin-site variability between subjects",
  ],
  opm: [
    "Sensitive to ambient magnetic field — shielded room required",
    "Head movement modulates sensor gain",
    "Cell heating drifts with room temperature",
  ],
  smartphone_camera: [
    "Auto-exposure/white-balance drift between clips",
    "HEIC/HEVC files aren't ingest-friendly — convert to MP4",
    "Rolling shutter warps fast motion",
  ],
  skin_temperature: [
    "Ambient conductive/convective loss confounds readings",
    "Adhesive lift-off after 12–24 h",
    "Slow response time (seconds) misses transients",
  ],
  vr: [
    "Simulator sickness at high vection with low frame rate",
    "Lighthouse occlusion loses head pose",
    "Latency between motion and display breaks presence",
  ],
  lidar: [
    "Reflective/black surfaces produce holes in the point cloud",
    "Rain/dust scatters returns",
    "Motion compensation needed for handheld capture",
  ],
  mmwave: [
    "Multipath ghosts in reflective rooms",
    "Range–velocity ambiguity from chirp config",
    "Regulatory limits on transmit power in some regions",
  ],
};

function issuesFor(row: DeviceRow): string[] {
  const cat = canonicalCategory(row);
  if (COMMON_ISSUES[cat.key]) return COMMON_ISSUES[cat.key];
  const cls = (row.device_class || "").toLowerCase();
  if (COMMON_ISSUES[cls]) return COMMON_ISSUES[cls];
  return [];
}

interface DeviceRow {
  grant_number: string;
  device_class: string | null;
  model_name: string | null;
  manufacturer: string | null;
  device_label?: string | null;
  hardware_label?: string | null;
  evidence_count: number | null;
  confidence_max: number | null;
  sample_pmid: string | null;
  sample_title: string | null;
  manual_urls: string[] | null;
  species: string[] | null;
  environment_tags: string[] | null;
  sample_use_case: string | null;
  setting: string | null;
  source_url?: string | null;
  source_grant_title?: string | null;
  source_org?: string | null;
  min_depth?: number | null;
  match_score_max?: number | null;
  quote?: string | null;
  latest_evidence_at?: string | null;
}

export default function Devices() {
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [quickFilterText, setQuickFilterText] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const isMobile = useIsMobile();

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("project_devices_v" as any)
      .select("*")
      .limit(1000);
    if (error) toast.error(error.message);
    const nextRows = ((data as any as DeviceRow[]) || []).filter((r) => {
      const hasDeviceSignal = Boolean(
        r.model_name ||
        r.hardware_label ||
        r.manufacturer ||
        (r.device_class && r.device_class !== "unspecified") ||
        r.sample_use_case
      );
      const computationalOnly = (r.environment_tags || []).some((tag) => tag === "computational_only");
      const hasPhysicalContext = Boolean(
        r.manufacturer ||
        r.model_name ||
        (r.environment_tags || []).some((tag) => tag !== "computational_only")
      );
      // Restrict the page to the 32 canonical BBQS device categories only —
      // any row that falls into the catch-all "other" bucket is dropped.
      const inCanonicalTaxonomy = canonicalCategory(r).key !== "other";
      return hasDeviceSignal && (!computationalOnly || hasPhysicalContext) && inCanonicalTaxonomy;
    });
    setRows(nextRows);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const channel = supabase
      .channel("devices-page-evidence-refresh")
      .on("postgres_changes", { event: "*", schema: "public", table: "grant_methods_evidence" }, () => {
        load();
      })
      .subscribe();
    const timer = window.setInterval(load, 30000);
    return () => {
      window.clearInterval(timer);
      supabase.removeChannel(channel);
    };
  }, []);

  const deviceName = (r: DeviceRow) =>
    r.device_label || r.model_name || r.hardware_label || (r.device_class ? r.device_class.replace(/_/g, " ") : "Device evidence");

  const isModelKnown = (r: DeviceRow) => Boolean(r.model_name || r.manufacturer);

  const filteredRows = useMemo(
    () => (categoryFilter === "all" ? rows : rows.filter((r) => canonicalCategory(r).key === categoryFilter)),
    [rows, categoryFilter]
  );
  const physicalRows = filteredRows.filter((r) => !(r.environment_tags || []).includes("computational_only"));
  const modelRows = filteredRows.filter((r) => isModelKnown(r));
  const missingModels = filteredRows.length - modelRows.length;

  // Per-category counts (across full row set, not just current filter) — used
  // to power the taxonomy chips row.
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const k = canonicalCategory(r).key;
      counts[k] = (counts[k] || 0) + 1;
    }
    return counts;
  }, [rows]);

  const defaultColDef = useMemo<ColDef>(
    () => ({ sortable: true, resizable: true, filter: true, unSortIcon: true, wrapText: true, autoHeight: true }),
    []
  );

  const columnDefs = useMemo<ColDef<DeviceRow>[]>(() => [
    {
      headerName: "Device",
      minWidth: 280,
      flex: 1.2,
      valueGetter: (p) => (p.data ? deviceName(p.data) : ""),
      cellRenderer: (p: any) => (
        <div className="py-1">
          <div className="text-sm font-semibold text-foreground leading-snug">{deviceName(p.data)}</div>
          {!isModelKnown(p.data) && (
            <div className="text-[11px] text-muted-foreground mt-0.5 italic">— model TBD</div>
          )}
        </div>
      ),
    },
    {
      headerName: "BBQS category", width: 190,
      valueGetter: (p) => (p.data ? canonicalCategory(p.data).label : ""),
      cellRenderer: (p: any) => (
        <Badge variant="outline" className="text-xs border-primary/40 text-primary">
          {canonicalCategory(p.data).label}
        </Badge>
      ),
    },
    {
      field: "manufacturer", headerName: "Manufacturer", width: 140,
      cellRenderer: (p: any) => p.value || <span className="text-muted-foreground text-xs">—</span>,
    },
    {
      field: "species", headerName: "Species", width: 160,
      getQuickFilterText: (p) => (p.value || []).join(" "),
      cellRenderer: (p: any) => (p.value && p.value.length) ? (
        <div className="flex flex-wrap gap-1">
          {p.value.slice(0, 3).map((s: string) => (
            <Badge key={s} variant="secondary" className="text-[10px]">{s.replace(/_/g, " ")}</Badge>
          ))}
        </div>
      ) : <span className="text-muted-foreground text-xs">—</span>,
    },
    {
      field: "environment_tags", headerName: "Environment", width: 180,
      getQuickFilterText: (p) => (p.value || []).join(" "),
      cellRenderer: (p: any) => (p.value && p.value.length) ? (
        <div className="flex flex-wrap gap-1">
          {p.value.slice(0, 3).map((t: string) => (
            <Badge key={t} variant="outline" className="text-[10px] border-primary/30 text-primary">{t.replace(/_/g, " ")}</Badge>
          ))}
        </div>
      ) : p.data?.setting ? (
        <Badge variant="outline" className="text-[10px]">{p.data.setting}</Badge>
      ) : <span className="text-muted-foreground text-xs">—</span>,
    },
    {
      headerName: "How it's used in this project",
      headerTooltip: "Plain-English summary of how this device shows up in the grant/paper, plus the exact snippet we pulled it from.",
      flex: 1, minWidth: 300,
      valueGetter: (p) => `${p.data?.sample_use_case ?? ""} ${p.data?.quote ?? ""}`,
      cellRenderer: (p: any) => {
        const useCase: string = p.data?.sample_use_case || "";
        const raw: string = (p.data?.quote || "").replace(/\s+/g, " ").trim();
        // Trim to first sentence or ~200 chars so the row stays readable.
        let snippet = raw;
        if (snippet.length > 220) {
          const cut = snippet.slice(0, 220);
          const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
          snippet = (lastStop > 80 ? cut.slice(0, lastStop + 1) : cut) + "…";
        }
        if (!useCase && !snippet) {
          return <span className="text-muted-foreground text-xs">not yet summarized</span>;
        }
        return (
          <div className="text-xs py-1 space-y-1">
            {useCase && <div className="text-foreground/90 leading-snug">{useCase}</div>}
            {snippet && (
              <div className="italic text-muted-foreground/80 leading-snug">"{snippet}"</div>
            )}
          </div>
        );
      },
    },
    {
      headerName: "Common problems",
      headerTooltip: "Known gotchas for this class of device — collected from shared lab experience, not extracted per-paper.",
      width: 320,
      sortable: false,
      filter: false,
      valueGetter: (p) => (p.data ? issuesFor(p.data).join(" · ") : ""),
      cellRenderer: (p: any) => {
        const issues = issuesFor(p.data);
        if (!issues.length) {
          return <span className="text-muted-foreground text-xs">no common-issue notes yet</span>;
        }
        return (
          <ul className="text-xs py-1 space-y-1 list-disc pl-4 text-foreground/85 leading-snug">
            {issues.map((t) => <li key={t}>{t}</li>)}
          </ul>
        );
      },
    },
    {
      field: "grant_number", headerName: "Grant", width: 150,
      cellRenderer: (p: any) => (
        <Link to={`/projects/${p.value}/profile`} className="text-primary hover:underline font-mono text-xs">{p.value}</Link>
      ),
    },
    {
      field: "evidence_count", headerName: "Evidence", width: 110, type: "numericColumn",
      sort: "desc",
      cellClass: "text-right tabular-nums",
    },
    {
      headerName: "Source", width: 150, sortable: false, filter: false,
      cellRenderer: (p: any) => (
        <div className="flex flex-col gap-1 py-1">
          {p.data.source_url && (
            <a href={p.data.source_url} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1 text-xs">
              <ExternalLink className="h-3 w-3" />
              {String(p.data.sample_pmid || "").startsWith("PROJECT:") ? "NIH abstract" : "paper"}
            </a>
          )}
          {p.data.manual_urls?.[0] ? (
            <a href={p.data.manual_urls[0]} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1 text-xs">
              <ExternalLink className="h-3 w-3" /> Manual
            </a>
          ) : <span className="text-muted-foreground text-[10px]">manual pending</span>}
          {typeof p.data.min_depth === "number" && (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              hop {p.data.min_depth} · score {typeof p.data.match_score_max === "number" ? p.data.match_score_max.toFixed(2) : "—"}
            </span>
          )}
        </div>
      ),
    },
  ], []);

  return (
    <div className="w-full px-4 sm:px-6 py-8">
      <PageMeta
        title="Devices — Instruments used across BBQS projects"
        description="Hardware, models, manufacturers, and manuals extracted from BBQS grants and their publications."
      />

      <div className="mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold text-foreground mb-1">Devices</h1>
            <p className="text-sm text-muted-foreground max-w-2xl">
              Two views of the same instrumentation. <strong className="text-foreground">Catalog</strong> is the
              curated registry: real products, their makers, what they output, and where the manuals live.
              <strong className="text-foreground"> In projects</strong> is what we extracted from BBQS grants and
              papers — species, environment, and how each device was actually used.
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/resources/devices/graph">
              <Network className="h-4 w-4 mr-2" />
              View knowledge graph
            </Link>
          </Button>
        </div>
      </div>

      <Tabs defaultValue="catalog" className="w-full">
        <TabsList className="mb-5">
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="map">Project map</TabsTrigger>
          <TabsTrigger value="projects">Evidence</TabsTrigger>
        </TabsList>

        <TabsContent value="catalog">
          <DeviceCatalog />
        </TabsContent>

        <TabsContent value="map">
          <DeviceProjectMap />
        </TabsContent>

        <TabsContent value="projects">
      <div className="mb-4 flex gap-2 items-center">
        <input
          type="text"
          placeholder="Filter by device, manufacturer, species, environment, grant…"
          value={quickFilterText}
          onChange={(e) => setQuickFilterText(e.target.value)}
          className="px-4 py-2 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary w-full max-w-md"
        />
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filteredRows.length} / {rows.length} rows
        </span>
      </div>

      {/* Canonical BBQS taxonomy — 32 categories */}
      <div className="mb-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
          BBQS device taxonomy · {BBQS_TAXONOMY.length - 1} categories
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setCategoryFilter("all")}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              categoryFilter === "all"
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-foreground border-border hover:border-primary/50"
            }`}
          >
            All ({rows.length})
          </button>
          {BBQS_TAXONOMY.map((c) => {
            const n = categoryCounts[c.key] || 0;
            const active = categoryFilter === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setCategoryFilter(c.key)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : n > 0
                    ? "bg-background text-foreground border-border hover:border-primary/50"
                    : "bg-muted/40 text-muted-foreground border-transparent"
                }`}
                title={n === 0 ? "No evidence yet" : `${n} evidence rows`}
              >
                {c.label} {n > 0 && <span className="opacity-70">· {n}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mb-4 grid gap-3 md:grid-cols-4">
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-2xl font-semibold text-foreground">{rows.length}</div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">device signals</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-2xl font-semibold text-foreground">{physicalRows.length}</div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">physical contexts</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-2xl font-semibold text-foreground">{modelRows.length}</div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">named models</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-2xl font-semibold text-foreground">{missingModels}</div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">need manufacturer/model</div>
        </div>
      </div>

      {isMobile ? (
        <MobileCardList
          items={filteredRows.map((r, i) => ({
            id: String(i),
            title: deviceName(r),
            fields: [
              { label: "Category", value: canonicalCategory(r).label },
              { label: "Manufacturer", value: r.manufacturer || "—" },
              { label: "Species", value: (r.species || []).join(", ") || "—" },
              { label: "Environment", value: (r.environment_tags || []).join(", ") || r.setting || "—" },
              { label: "Grant", value: r.grant_number },
              { label: "Evidence", value: String(r.evidence_count ?? 0) },
            ],
          }))}
          emptyMessage={loading ? "Loading devices…" : "No devices extracted yet."}
        />
      ) : (
        <div className="ag-theme-alpine rounded-lg border border-border overflow-x-auto" style={{ width: "100%" }}>
          <AgGridReact<DeviceRow>
            rowData={filteredRows}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            quickFilterText={quickFilterText}
            animateRows={true}
            domLayout="autoHeight"
            suppressCellFocus={true}
            enableCellTextSelection={true}
            headerHeight={40}
            overlayNoRowsTemplate={loading ? "Loading devices…" : "No devices extracted yet. Check back soon."}
          />
        </div>
      )}
        </TabsContent>
      </Tabs>
    </div>
  );
}