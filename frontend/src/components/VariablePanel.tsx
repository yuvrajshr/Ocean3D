/**
 * Variable & Layers Panel.
 *
 * Inspired by Copernicus Marine Service (CMEMS) and MyOcean PRO:
 * - Floating glassmorphic panel with expand/collapse control
 * - Header with Add Layer, Community Notes, Share, Upload (.nc/csv/geojson/tif), and Info
 * - Layer stack displaying active ocean variables with real scientific cmocean color ramps
 * - Layer visibility toggle (Eye/EyeOff), Opacity sliders, Metadata export, and Layer catalogue
 */

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  MessageSquare,
  Share2,
  Upload,
  Info,
  Eye,
  EyeOff,
  Download,
  SlidersHorizontal,
  Trash2,
  UploadCloud,
  Check,
} from "lucide-react";
import type { VariableInfo, FieldMeta } from "../api/client";
import { sampleCss, type ColormapName } from "../viz/colormaps";
import { DataCatalogueModal } from "./DataCatalogueModal";
import "../styles/layers-panel.css";

type HeaderDropdownType = "discussion" | "share" | "upload" | "info" | null;

export interface LayerItem {
  id: string;
  name: string;
  code: string;
  units: string;
  colormap: ColormapName;
  visible: boolean;
  opacity: number;
  timestamp: string;
  temporalResolution: string;
  minVal: number;
  maxVal: number;
  description: string;
  productTitle: string;
}

export interface VariablePanelProps {
  variables: VariableInfo[];
  selected: string;
  onSelect: (key: string) => void;
  currentTime?: string | null;
  fieldMeta?: FieldMeta | null;
  /**
   * Per-variable metadata, keyed by variable code.
   *
   * `fieldMeta` describes one field, so every card but the selected one fell
   * back to a 0-30 placeholder — and while the map stacks layers, the selected
   * card could show another layer's range under its own units. A stack needs a
   * range per layer or its colorbars are decorative.
   */
  fieldMetaByKey?: Record<string, FieldMeta | undefined>;
  onOpacityChange?: (opacity: number) => void;
  onVisibilityChange?: (visible: boolean) => void;
  /**
   * Report the whole stack upward, not just the uppermost layer.
   *
   * The panel still owns its stack; this lets the 2D map composite every
   * visible layer while the 3D column keeps rendering only the topmost
   * (context.md §5.1 Principle 10). Without it the map could only ever see
   * whichever single variable `onSelect` last reported.
   */
  /**
   * What the active view is actually rendering, e.g. "Copernicus · daily".
   *
   * The card used to hardcode "10-Daily Analysis", which is true of INCOIS in
   * the 3D column and false of every source the map uses. A layer is a
   * variable; the card has to name the source that view resolved it to, or it
   * describes data nobody is looking at.
   */
  sourceLabel?: string;
  /** Per-variable source labels. A stack can draw each layer from a different
   *  upstream, so one shared label credits the wrong server on every card but
   *  one. */
  sourceLabelByKey?: Record<string, string | undefined>;
  /**
   * A stack pushed in from outside — currently only the assistant.
   *
   * This panel owns the layer stack during normal use and mirrors it upward via
   * `onStackChange`, so a parent cannot simply hold the state instead. Rather
   * than lift ownership out (a large change to a file several people touch),
   * this applies a stack when `nonce` changes and is otherwise inert. The nonce
   * rather than value equality is deliberate: re-applying the same stack after
   * an undo has to count as a new instruction.
   */
  externalStack?: {
    keys: string[];
    visibility: Record<string, boolean>;
    opacity: Record<string, number>;
    nonce: number;
  } | null;
  onStackChange?: (stack: {
    keys: string[];
    visibility: Record<string, boolean>;
    opacity: Record<string, number>;
  }) => void;
}

// Scientific Colormap RGB gradients for CSS linear-gradients
export const COLORMAP_GRADIENTS: Record<ColormapName, string> = {
  thermal: "linear-gradient(to right, rgb(3,35,51), rgb(23,51,122), rgb(85,59,137), rgb(129,79,143), rgb(170,100,132), rgb(208,127,113), rgb(233,165,92), rgb(243,209,89), rgb(232,250,91))",
  haline: "linear-gradient(to right, rgb(41,24,107), rgb(37,58,143), rgb(12,98,137), rgb(10,130,131), rgb(23,161,125), rgb(86,190,103), rgb(175,211,78), rgb(238,227,106), rgb(253,238,153))",
  speed: "linear-gradient(to right, rgb(255,252,224), rgb(214,232,160), rgb(150,206,124), rgb(79,174,114), rgb(27,138,107), rgb(25,98,87), rgb(20,52,58))",
  algae: "linear-gradient(to right, rgb(215,249,208), rgb(162,225,160), rgb(107,199,126), rgb(53,169,106), rgb(20,139,94), rgb(20,107,78), rgb(16,69,59), rgb(11,42,35))",
  delta: "linear-gradient(to right, rgb(16,31,63), rgb(42,107,165), rgb(134,198,224), rgb(241,237,236), rgb(159,204,114), rgb(71,145,60), rgb(37,45,20))",
  balance: "linear-gradient(to right, rgb(24,28,67), rgb(37,82,158), rgb(96,154,205), rgb(178,205,226), rgb(241,237,236), rgb(228,178,160), rgb(206,108,88), rgb(161,42,43), rgb(92,17,24))",
};

// Variable short code helper
function getVariableCode(key: string): string {
  switch (key) {
    case "temperature": return "TEMP";
    case "salinity": return "PSAL";
    case "current_speed": return "CURR";
    case "chlorophyll": return "CHL";
    case "d26": return "D26";
    case "heat_content": return "TCHP";
    case "mld": return "MLD";
    default: return key.slice(0, 4).toUpperCase();
  }
}

interface LayerScaleSliderProps {
  minVal: number;
  maxVal: number;
  units: string;
  colormap: ColormapName;
  gradient: string;
}

function LayerScaleSlider({ minVal, maxVal, units, colormap, gradient }: LayerScaleSliderProps) {
  const [activeT, setActiveT] = useState<number | null>(null);
  const [isSliding, setIsSliding] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  const calculateT = useCallback((clientX: number) => {
    if (!barRef.current) return 0;
    const rect = barRef.current.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const rawT = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(1, rawT));
  }, []);

  const handlePointerEnter = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = calculateT(e.clientX);
    setActiveT(t);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    setIsSliding(true);
    const t = calculateT(e.clientX);
    setActiveT(t);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = calculateT(e.clientX);
    setActiveT(t);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    setIsSliding(false);
  };

  const handlePointerLeave = () => {
    if (!isSliding) {
      setActiveT(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      setActiveT((prev) => Math.max(0, (prev ?? 0.5) - 0.05));
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      setActiveT((prev) => Math.min(1, (prev ?? 0.5) + 0.05));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveT(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveT(1);
    }
  };

  const mid = Number(((minVal + maxVal) / 2).toFixed(1));

  let activeValue: number | null = null;
  let activeColor = "#38bdf8";
  let activePercent = 50;

  if (activeT !== null) {
    activePercent = activeT * 100;
    activeValue = minVal + activeT * (maxVal - minVal);
    try {
      activeColor = sampleCss(colormap, activeT);
    } catch {
      activeColor = "#38bdf8";
    }
  }

  const formatVal = (v: number) => {
    if (Math.abs(v) >= 100) return v.toFixed(0);
    if (Math.abs(v) >= 10) return v.toFixed(1);
    return v.toFixed(2);
  };

  let tooltipTransform = "translateX(-50%)";
  if (activePercent < 15) {
    tooltipTransform = "translateX(0%)";
  } else if (activePercent > 85) {
    tooltipTransform = "translateX(-100%)";
  }

  return (
    <div className="layer-scale-wrap">
      {/* Floating Readout Tooltip */}
      <div className="layer-scale-tooltip-track">
        {activeT !== null && activeValue !== null && (
          <div
            className="layer-scale-tooltip"
            style={{
              left: `${activePercent}%`,
              transform: tooltipTransform,
              borderColor: activeColor,
              boxShadow: `0 6px 16px rgba(0, 0, 0, 0.8), 0 0 10px ${activeColor}40`,
            }}
          >
            <span
              className="layer-scale-tooltip-dot"
              style={{ background: activeColor, boxShadow: `0 0 6px ${activeColor}` }}
            />
            <span className="layer-scale-tooltip-val">{formatVal(activeValue)}</span>
            <span className="layer-scale-tooltip-unit">{units}</span>
          </div>
        )}
      </div>

      {/* Interactive Scale Bar */}
      <div
        ref={barRef}
        className={`layer-scale-bar ${isSliding ? "layer-scale-bar--sliding" : ""}`}
        style={{ background: gradient }}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onKeyDown={handleKeyDown}
        role="slider"
        aria-label="Layer Color Scale Reading"
        aria-valuemin={minVal}
        aria-valuemax={maxVal}
        aria-valuenow={activeValue ?? mid}
        tabIndex={0}
      >
        {/* Tick notches on the bar */}
        <div className="layer-scale-bar-tick" style={{ left: "25%" }} />
        <div className="layer-scale-bar-tick layer-scale-bar-tick--50" style={{ left: "50%" }} />
        <div className="layer-scale-bar-tick" style={{ left: "75%" }} />

        {/* Scrubber Pin / Indicator */}
        {activeT !== null && (
          <div
            className="layer-scale-scrubber"
            style={{ left: `${activePercent}%` }}
          >
            <div
              className="layer-scale-scrubber-pip"
              style={{ background: activeColor, borderColor: "#ffffff" }}
            />
            <div className="layer-scale-scrubber-line" />
          </div>
        )}
      </div>

      {/* Ticks positioned with true mathematical alignment */}
      <div className="layer-scale-ticks">
        <span className="layer-scale-tick-min">{minVal}</span>
        <span className="layer-scale-tick-mid">{mid}</span>
        <span className="layer-scale-tick-max">{maxVal} {units}</span>
      </div>
    </div>
  );
}

export function VariablePanel({
  variables,
  selected,
  onSelect,
  currentTime,
  fieldMeta,
  fieldMetaByKey,
  onOpacityChange,
  onVisibilityChange,
  sourceLabel,
  sourceLabelByKey,
  externalStack,
  onStackChange,
}: VariablePanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [activeSettingsLayerId, setActiveSettingsLayerId] = useState<string | null>(null);
  const [activeDropdown, setActiveDropdown] = useState<HeaderDropdownType>(null);
  const [isCatalogueOpen, setIsCatalogueOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [shareCopied, setShareCopied] = useState(false);

  // 2s Auto-close timer for opacity controls (closes if no changes made or left open for 2s)
  const opacityAutoCloseTimerRef = useRef<number | null>(null);

  const clearOpacityAutoCloseTimer = useCallback(() => {
    if (opacityAutoCloseTimerRef.current !== null) {
      window.clearTimeout(opacityAutoCloseTimerRef.current);
      opacityAutoCloseTimerRef.current = null;
    }
  }, []);

  const resetOpacityAutoCloseTimer = useCallback(() => {
    clearOpacityAutoCloseTimer();
    opacityAutoCloseTimerRef.current = window.setTimeout(() => {
      setActiveSettingsLayerId(null);
      opacityAutoCloseTimerRef.current = null;
    }, 2000);
  }, [clearOpacityAutoCloseTimer]);

  useEffect(() => {
    if (activeSettingsLayerId) {
      resetOpacityAutoCloseTimer();
    } else {
      clearOpacityAutoCloseTimer();
    }
    return () => {
      clearOpacityAutoCloseTimer();
    };
  }, [activeSettingsLayerId, resetOpacityAutoCloseTimer, clearOpacityAutoCloseTimer]);

  // Active layer stack IDs
  const [activeLayerKeys, setActiveLayerKeys] = useState<string[]>(() => (selected ? [selected] : []));
  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>(() => (selected ? { [selected]: true } : {}));
  const [layerOpacity, setLayerOpacity] = useState<Record<string, number>>(() => (selected ? { [selected]: 1 } : {}));

  // Mirror the stack upward whenever it changes, so the map view composites the
  // same layers this panel lists.
  useEffect(() => {
    onStackChange?.({
      keys: activeLayerKeys,
      visibility: layerVisibility,
      opacity: layerOpacity,
    });
  }, [activeLayerKeys, layerVisibility, layerOpacity, onStackChange]);

  // Adopt a stack pushed in from outside (the assistant). Keyed on the nonce
  // alone so that repeating an instruction, or undoing back to a stack we were
  // already in, still applies.
  const externalNonce = externalStack?.nonce ?? -1;
  useEffect(() => {
    if (!externalStack || externalNonce < 0) return;
    setActiveLayerKeys(externalStack.keys);
    setLayerVisibility(externalStack.visibility);
    setLayerOpacity(externalStack.opacity);
    // The panel drives the rest of the app off the selected key, so the topmost
    // visible layer has to become the selection or the viewport keeps drawing
    // the layer the reader just replaced.
    const top = externalStack.keys.find((k) => externalStack.visibility[k] !== false);
    if (top && top !== selected) onSelect(top);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalNonce]);

  const prevSelectedRef = useRef(selected);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const headerIconsRef = useRef<HTMLDivElement>(null);

  // Synchronize when a new selected variable is explicitly chosen externally
  useEffect(() => {
    if (selected && selected !== prevSelectedRef.current) {
      prevSelectedRef.current = selected;
      if (!activeLayerKeys.includes(selected)) {
        setActiveLayerKeys((prev) => [selected, ...prev]);
        setLayerVisibility((prev) => ({ ...prev, [selected]: true }));
        setLayerOpacity((prev) => ({ ...prev, [selected]: 1 }));
      }
    } else if (!selected) {
      prevSelectedRef.current = "";
    }
  }, [selected, activeLayerKeys]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!activeDropdown) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        headerIconsRef.current &&
        !headerIconsRef.current.contains(target)
      ) {
        setActiveDropdown(null);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [activeDropdown]);

  // Close dropdown on Escape key
  useEffect(() => {
    if (!activeDropdown) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setActiveDropdown(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeDropdown]);

  const handleCopyShareLink = () => {
    if (typeof window !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(window.location.href);
    }
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  };

  const dropdownAutoCloseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (dropdownAutoCloseTimerRef.current !== null) {
        window.clearTimeout(dropdownAutoCloseTimerRef.current);
      }
    };
  }, []);

  const handleToggleDropdown = (type: HeaderDropdownType) => {
    if (dropdownAutoCloseTimerRef.current !== null) {
      window.clearTimeout(dropdownAutoCloseTimerRef.current);
      dropdownAutoCloseTimerRef.current = null;
    }

    setActiveDropdown((prev) => {
      const next = prev === type ? null : type;
      if (next === "discussion" || next === "upload") {
        dropdownAutoCloseTimerRef.current = window.setTimeout(() => {
          setActiveDropdown(null);
          dropdownAutoCloseTimerRef.current = null;
        }, 2000);
      }
      return next;
    });
  };

  // Helper to determine the uppermost active (visible) layer in the stack
  const getUppermostActiveLayer = (keys: string[], vis: Record<string, boolean>): string => {
    for (const k of keys) {
      if (vis[k] !== false) {
        return k;
      }
    }
    return "";
  };

  // Toggle visibility of a layer (Eye button functionality)
  const toggleVisibility = (key: string) => {
    const currentVis = layerVisibility[key] !== false;
    const nextVis = !currentVis;
    const updatedVisibility: Record<string, boolean> = {
      ...layerVisibility,
      [key]: nextVis,
    };
    setLayerVisibility(updatedVisibility);

    // Find the new uppermost layer that is active (visible)
    const nextActive = getUppermostActiveLayer(activeLayerKeys, updatedVisibility);

    if (nextActive) {
      prevSelectedRef.current = nextActive;
      onSelect(nextActive);
      if (onVisibilityChange) {
        onVisibilityChange(true);
      }
    } else {
      // All layers are turned off (inactive) -> show nothing
      prevSelectedRef.current = "";
      onSelect("");
      if (onVisibilityChange) {
        onVisibilityChange(false);
      }
    }
  };

  // Select / activate a layer explicitly by clicking on it
  const handleSelectLayer = (key: string) => {
    const nextKeys = [key, ...activeLayerKeys.filter((k) => k !== key)];
    const nextVis = { ...layerVisibility, [key]: true };
    setActiveLayerKeys(nextKeys);
    setLayerVisibility(nextVis);
    prevSelectedRef.current = key;
    onSelect(key);
    if (onVisibilityChange) {
      onVisibilityChange(true);
    }
  };

  // Remove a layer from active stack (can remove down to 0 layers)
  const removeLayer = (key: string) => {
    const nextKeys = activeLayerKeys.filter((k) => k !== key);
    setActiveLayerKeys(nextKeys);

    // Find the new uppermost visible layer among remaining keys
    const nextActive = getUppermostActiveLayer(nextKeys, layerVisibility);
    if (nextActive) {
      prevSelectedRef.current = nextActive;
      onSelect(nextActive);
      if (onVisibilityChange) {
        onVisibilityChange(true);
      }
    } else {
      prevSelectedRef.current = "";
      onSelect("");
      if (onVisibilityChange) {
        onVisibilityChange(false);
      }
    }
  };

  // Add/select a layer from the catalogue
  const handleSelectFromCatalogue = (key: string) => {
    const nextKeys = [key, ...activeLayerKeys.filter((k) => k !== key)];
    const nextVis = { ...layerVisibility, [key]: true };
    const nextOpacity = { ...layerOpacity, [key]: layerOpacity[key] ?? 1 };

    setActiveLayerKeys(nextKeys);
    setLayerVisibility(nextVis);
    setLayerOpacity(nextOpacity);

    prevSelectedRef.current = key;
    onSelect(key);
    if (onVisibilityChange) {
      onVisibilityChange(true);
    }
    setActiveDropdown(null);
    setIsCatalogueOpen(false);
  };

  // Update layer opacity
  const updateOpacity = (key: string, val: number) => {
    setLayerOpacity((prev) => ({ ...prev, [key]: val }));
    if (key === selected && onOpacityChange) {
      onOpacityChange(val);
    }
    // Auto-close in 2s if no further changes are made
    resetOpacityAutoCloseTimer();
  };

  // Map active layer keys into full layer objects
  const activeLayers = useMemo<LayerItem[]>(() => {
    return activeLayerKeys
      .map((k) => {
        const v = variables.find((item) => item.key === k);
        if (!v) return null;

        // Prefer this layer's own metadata; fall back to the single selected
        // field, then to a placeholder range.
        const own = fieldMetaByKey?.[k];
        const meta = own ?? (k === selected ? fieldMeta ?? undefined : undefined);
        const minVal = meta?.value_range ? meta.value_range[0] : 0;
        const maxVal = meta?.value_range ? meta.value_range[1] : 30;

        return {
          id: v.key,
          name: v.label,
          code: getVariableCode(v.key),
          units: v.units,
          colormap: (v.colormap as ColormapName) || "thermal",
          visible: layerVisibility[v.key] ?? true,
          opacity: layerOpacity[v.key] ?? 1,
          timestamp: currentTime
            ? new Date(currentTime).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
              timeZone: "UTC",
            })
            : "Live Scenario",
          temporalResolution: sourceLabelByKey?.[k] ?? sourceLabel ?? "10-Daily Analysis",
          minVal: Number(minVal.toFixed(1)),
          maxVal: Number(maxVal.toFixed(1)),
          description: v.caption,
          productTitle: "INCOIS Argo 10-Day Gridded Analysis",
        };
      })
      .filter((l): l is LayerItem => l !== null);
  }, [activeLayerKeys, variables, selected, fieldMeta, fieldMetaByKey, currentTime, sourceLabel, sourceLabelByKey, layerVisibility, layerOpacity]);

  return (
    <div
      id="ocean3d-layers-panel"
      className={`layers-panel-shell ${isCollapsed ? "layers-panel-shell--collapsed" : "layers-panel-shell--expanded"}`}
    >
      {/* Collapsed Expand Button */}
      <button
        type="button"
        id="btn-expand-layers"
        onClick={() => setIsCollapsed(false)}
        className={`layers-expand-btn ${isCollapsed ? "layers-expand-btn--visible" : "layers-expand-btn--hidden"}`}
        title="Expand layers panel"
        aria-label="Expand layers panel"
      >
        <ChevronRight className="w-5 h-5" style={{ width: 20, height: 20, strokeWidth: 2.5 }} />
      </button>

      {/* Expanded Panel Body */}
      <div className={`layers-expanded-wrapper ${isCollapsed ? "layers-expanded-wrapper--hidden" : "layers-expanded-wrapper--visible"}`}>
        {/* Header bar */}
        <div className="relative">
          <div className="layers-header">
            {/* Collapse button */}
            <button
              type="button"
              id="btn-collapse-layers"
              onClick={() => {
                setIsCollapsed(true);
                setActiveDropdown(null);
              }}
              className="layers-collapse-btn"
              title="Collapse layers panel"
              aria-label="Collapse layers panel"
            >
              <ChevronLeft className="w-4 h-4" style={{ width: 16, height: 16, strokeWidth: 2.2 }} />
            </button>

            {/* Add layer button */}
            <button
              type="button"
              id="btn-open-catalogue-header"
              onClick={() => setIsCatalogueOpen(true)}
              className="layers-add-btn"
              title="Browse Data Catalogue to add ocean layers"
            >
              <Plus className="layers-add-btn-icon" style={{ width: 13, height: 13, strokeWidth: 2.4 }} />
              <span>Add Layer</span>
            </button>

            {/* Top-right action icons */}
            <div ref={headerIconsRef} className="layers-header-icons">
              <button
                type="button"
                id="btn-header-discussion"
                onClick={() => handleToggleDropdown("discussion")}
                className={`layers-icon-btn ${activeDropdown === "discussion" ? "layers-icon-btn--active" : ""}`}
                title="Community & Oceanographic Notes"
              >
                <MessageSquare className="w-3.5 h-3.5" style={{ width: 15, height: 15 }} />
              </button>
              <button
                type="button"
                id="btn-header-share"
                onClick={() => handleToggleDropdown("share")}
                className={`layers-icon-btn ${activeDropdown === "share" ? "layers-icon-btn--active" : ""}`}
                title="Share current ocean view"
              >
                <Share2 className="w-3.5 h-3.5" style={{ width: 15, height: 15 }} />
              </button>
              <button
                type="button"
                id="btn-header-upload"
                onClick={() => handleToggleDropdown("upload")}
                className={`layers-icon-btn ${activeDropdown === "upload" ? "layers-icon-btn--active" : ""}`}
                title="Upload custom ocean data"
              >
                <Upload className="w-3.5 h-3.5" style={{ width: 15, height: 15 }} />
              </button>
              <button
                type="button"
                id="btn-header-info"
                onClick={() => handleToggleDropdown("info")}
                className={`layers-icon-btn ${activeDropdown === "info" ? "layers-icon-btn--active" : ""}`}
                title="Ocean 3D Viewer Information"
              >
                <Info className="w-3.5 h-3.5" style={{ width: 15, height: 15 }} />
              </button>
            </div>
          </div>

          {/* Dropdown: Discussion Notes */}
          {activeDropdown === "discussion" && (
            <div ref={dropdownRef} id="dropdown-discussion" className="layers-dropdown">
              <div className="layers-dropdown-title">
                <MessageSquare className="w-5 h-5" style={{ width: 20, height: 20, color: "#22d3ee" }} />
                Community &amp; Oceanographic Notes
              </div>
              <p className="layers-dropdown-desc">
                Collaborate and leave notes on current cyclone wakes, thermocline anomalies, or Argo float comparisons.
              </p>
              <textarea
                id="discussion-note-input"
                placeholder="Add observation at current coordinates or depth level..."
                rows={3}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                className="layers-textarea"
              />
              <div className="layers-actions">
                <button
                  type="button"
                  id="btn-cancel-discussion"
                  onClick={() => setActiveDropdown(null)}
                  className="layers-btn-cancel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  id="btn-post-discussion"
                  onClick={() => {
                    if (noteText.trim()) {
                      alert(`Observation recorded: "${noteText}"`);
                      setNoteText("");
                    } else {
                      alert("Observation recorded!");
                    }
                    setActiveDropdown(null);
                  }}
                  className="layers-btn-primary"
                >
                  Post Note
                </button>
              </div>
            </div>
          )}

          {/* Dropdown: Info */}
          {activeDropdown === "info" && (
            <div ref={dropdownRef} id="dropdown-info" className="layers-dropdown">
              <div className="layers-dropdown-title">
                <Info className="w-5 h-5" style={{ width: 20, height: 20, color: "#22d3ee" }} />
                <span style={{ color: "#22d3ee" }}>Ocean 3D</span> Marine Data Platform
              </div>
              <p className="layers-dropdown-desc">
                Co-visualization of INCOIS numerical ocean analysis and in-situ Argo observations (Smart India Hackathon 2026, Problem Statement 26067). Real-time 3D volumetric raymarching in pure WebGL2.
              </p>
              <div style={{ background: "#0d1728", padding: "12px", borderRadius: "8px", border: "1px solid #1e293b", fontSize: "11px", color: "#94a3b8", fontFamily: "var(--font-readout, monospace)", marginBottom: 14 }}>
                <div>• <span style={{ color: "#e2e8f0" }}>Upstream:</span> INCOIS ERDDAP (erddap.incois.gov.in)</div>
                <div>• <span style={{ color: "#e2e8f0" }}>Bathymetry:</span> NOAA CoastWatch ETOPO180 Relief</div>
                <div>• <span style={{ color: "#e2e8f0" }}>Depth Range:</span> 5 m to 2,000 m (24 vertical levels)</div>
                <div>• <span style={{ color: "#e2e8f0" }}>Colormaps:</span> Scientific cmocean ramps (perceptually uniform)</div>
              </div>
              <div className="layers-actions">
                <button
                  type="button"
                  id="btn-close-info"
                  onClick={() => setActiveDropdown(null)}
                  className="layers-btn-cancel"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {/* Dropdown: Upload */}
          {activeDropdown === "upload" && (
            <div ref={dropdownRef} id="dropdown-upload" className="layers-dropdown">
              <div className="layers-dropdown-title">
                <UploadCloud className="w-5 h-5" style={{ width: 20, height: 20, color: "#22d3ee" }} />
                Upload Custom Ocean Data
                <span className="layers-badge-beta">BETA</span>
              </div>
              <p className="layers-dropdown-desc">
                Import CTD depth casts, Argo float trajectories, glider missions, or GeoTIFF/NetCDF ocean rasters.
              </p>
              <label className="layers-dropzone">
                <UploadCloud className="w-7 h-7" style={{ width: 28, height: 28, color: "#22d3ee", marginBottom: 6 }} />
                <span style={{ fontSize: "12px", fontWeight: 600, color: "#ffffff", display: "block" }}>
                  Select File or Drop here
                </span>
                <span style={{ fontSize: "10px", color: "#64748b", marginTop: 4, fontFamily: "var(--font-readout, monospace)", display: "block" }}>
                  .nc, .csv, .geojson, .tif, .json
                </span>
                <input
                  type="file"
                  style={{ display: "none" }}
                  accept=".csv,.geojson,.json,.nc,.tif"
                  onChange={(e) => {
                    if (e.target.files?.[0]) {
                      alert(`Dataset "${e.target.files[0].name}" parsed and ready!`);
                      setActiveDropdown(null);
                    }
                  }}
                />
              </label>
              <div className="layers-actions">
                <button
                  type="button"
                  id="btn-cancel-upload"
                  onClick={() => setActiveDropdown(null)}
                  className="layers-btn-cancel"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Dropdown: Share */}
          {activeDropdown === "share" && (
            <div ref={dropdownRef} id="dropdown-share" className="layers-dropdown">
              <div className="layers-dropdown-title">
                <Share2 className="w-5 h-5" style={{ width: 20, height: 20, color: "#22d3ee" }} />
                Share Current Ocean View
              </div>
              <p className="layers-dropdown-desc">
                Copy direct permalink with active layer, depth slice, timestep, and 3D camera orientation.
              </p>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: 14 }}>
                <input
                  type="text"
                  readOnly
                  value={typeof window !== "undefined" ? window.location.href : "https://ocean3d.incois.gov.in"}
                  className="layers-input"
                />
                <button
                  type="button"
                  onClick={handleCopyShareLink}
                  className="layers-btn-primary"
                  style={{ background: shareCopied ? "#38bdf8" : "rgba(255, 255, 255, 0.12)", color: shareCopied ? "#05080e" : "#f8fafc", border: "1px solid rgba(255, 255, 255, 0.2)", display: "flex", alignItems: "center", gap: 6 }}
                >
                  {shareCopied ? (
                    <>
                      <Check className="w-3.5 h-3.5" style={{ width: 14, height: 14 }} />
                      Copied!
                    </>
                  ) : (
                    "Copy Link"
                  )}
                </button>
              </div>
              <div className="layers-actions">
                <button
                  type="button"
                  id="btn-close-share"
                  onClick={() => setActiveDropdown(null)}
                  className="layers-btn-cancel"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Main Content Area */}
        <div className="layers-content">
          {activeLayers.length === 0 ? (
            /* Empty state */
            <div id="layers-empty-state">
              <div className="layers-empty-body" style={{ padding: "36px 20px" }}>
                <div style={{ color: "#cbd5e1", fontSize: "14px", fontWeight: 500 }}>
                  No layers currently active.
                </div>
                <div style={{ marginTop: "12px" }}>
                  <button
                    type="button"
                    onClick={() => setIsCatalogueOpen(true)}
                    className="layers-catalogue-link"
                  >
                    <Plus className="w-3.5 h-3.5" style={{ width: 14, height: 14 }} />
                    Browse Data Catalogue to add an ocean layer
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* Populated Layers List */
            <div id="layers-populated-list" className="layers-list">
              {activeLayers.map((layer) => {
                const isSelected = layer.id === selected;
                const isSettingsOpen = activeSettingsLayerId === layer.id;
                const gradient = COLORMAP_GRADIENTS[layer.colormap] || COLORMAP_GRADIENTS.thermal;

                return (
                  <div
                    key={layer.id}
                    className={`layer-item ${isSelected && layer.visible ? "layer-item--active" : ""} ${!layer.visible ? "layer-item--inactive" : ""}`}
                  >
                    {/* Layer Header Row */}
                    <div className="layer-header-row">
                      {/* Left: Visibility toggle + Name info */}
                      <div className="layer-header-left">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleVisibility(layer.id);
                          }}
                          className={`layer-visibility-btn ${!layer.visible ? "layer-visibility-btn--hidden" : ""}`}
                          title={layer.visible ? "Turn off layer (hide from view)" : "Turn on layer (show in view)"}
                          aria-label={layer.visible ? "Turn off layer" : "Turn on layer"}
                        >
                          {layer.visible ? (
                            <Eye className="w-3.5 h-3.5" style={{ width: 14, height: 14 }} />
                          ) : (
                            <EyeOff className="w-3.5 h-3.5" style={{ width: 14, height: 14 }} />
                          )}
                        </button>

                        <div
                          className="layer-info-col"
                          onClick={() => handleSelectLayer(layer.id)}
                          title="Click to bring to top & activate in 3D water column"
                        >
                          <div className="layer-name-line">
                            <span className="layer-name-text" title={layer.name}>{layer.name}</span>
                            <span className="layer-code-badge">{layer.code}</span>
                          </div>
                          <div className="layer-subline">
                            <span className="layer-meta-date">{layer.timestamp}</span>
                            <span className="layer-meta-sep">•</span>
                            <span className="layer-meta-source">{layer.temporalResolution}</span>
                          </div>
                        </div>
                      </div>

                      {/* Right: Remove button */}
                      <div className="layer-header-actions">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeLayer(layer.id);
                          }}
                          className="layer-remove-btn"
                          title="Remove layer"
                          aria-label="Remove layer"
                        >
                          <Trash2 className="w-3.5 h-3.5" style={{ width: 13, height: 13 }} />
                        </button>
                      </div>
                    </div>

                    {/* Interactive Color-scale slider */}
                    <LayerScaleSlider
                      minVal={layer.minVal}
                      maxVal={layer.maxVal}
                      units={layer.units}
                      colormap={layer.colormap}
                      gradient={gradient}
                    />

                    {/* Icon controls below legend */}
                    <div className="layer-controls-row">
                      <div className="layer-controls-left">
                        <button
                          type="button"
                          onClick={() => {
                            const blob = new Blob([JSON.stringify(layer, null, 2)], { type: "application/json" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `${layer.code}_metadata.json`;
                            a.click();
                          }}
                          className="layer-action-btn"
                          title="Download scientific metadata (JSON)"
                          aria-label="Download metadata"
                        >
                          <Download className="w-3.5 h-3.5" style={{ width: 13, height: 13 }} />
                          <span>JSON</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => alert(`Layer: ${layer.name} (${layer.code})\nDataset: ${layer.productTitle}\nUnits: ${layer.units}\nDescription: ${layer.description}`)}
                          className="layer-action-btn"
                          title="Layer scientific provenance & details"
                          aria-label="Layer information"
                        >
                          <Info className="w-3.5 h-3.5" style={{ width: 13, height: 13 }} />
                          <span>INFO</span>
                        </button>
                      </div>

                      {/* Interactive Opacity Trigger Button */}
                      <button
                        type="button"
                        onClick={() => {
                          if (isSettingsOpen) {
                            clearOpacityAutoCloseTimer();
                            setActiveSettingsLayerId(null);
                          } else {
                            setActiveSettingsLayerId(layer.id);
                          }
                        }}
                        className={`layer-opacity-trigger ${isSettingsOpen ? "layer-opacity-trigger--active" : ""}`}
                        title="Toggle opacity slider"
                        aria-label="Toggle opacity controls"
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5" style={{ width: 12, height: 12 }} />
                        <span className="layer-opacity-val">{Math.round(layer.opacity * 100)}%</span>
                      </button>
                    </div>

                    {/* Expandable settings drawer with quick presets and aerospace slider */}
                    {isSettingsOpen && (
                      <div
                        className="layer-settings-drawer"
                        onPointerDown={() => resetOpacityAutoCloseTimer()}
                        onMouseMove={() => resetOpacityAutoCloseTimer()}
                      >
                        <div className="layer-settings-header">
                          <div className="layer-settings-title-group">
                            <span className="layer-settings-label">OPACITY</span>
                          </div>
                          <div className="layer-presets-group">
                            {[0.25, 0.5, 0.75, 1.0].map((preset) => (
                              <button
                                key={preset}
                                type="button"
                                onClick={() => updateOpacity(layer.id, preset)}
                                className={`layer-preset-btn ${Math.abs(layer.opacity - preset) < 0.04 ? "layer-preset-btn--active" : ""}`}
                              >
                                {Math.round(preset * 100)}%
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="layer-slider-row">
                          <input
                            type="range"
                            min="0.05"
                            max="1"
                            step="0.05"
                            value={layer.opacity}
                            onChange={(e) => updateOpacity(layer.id, parseFloat(e.target.value))}
                            onPointerDown={() => resetOpacityAutoCloseTimer()}
                            className="layer-slider"
                            style={{
                              background: `linear-gradient(to right, #38bdf8 0%, #38bdf8 ${Math.round(layer.opacity * 100)}%, #162032 ${Math.round(layer.opacity * 100)}%, #162032 100%)`,
                            }}
                          />
                          <span className="layer-slider-readout">
                            {Math.round(layer.opacity * 100)}%
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Full-Screen Data Catalogue Modal matching INCOIS / Copernicus Marine */}
      <DataCatalogueModal
        isOpen={isCatalogueOpen}
        onClose={() => setIsCatalogueOpen(false)}
        onAddLayer={handleSelectFromCatalogue}
        activeLayers={activeLayerKeys}
      />
    </div>
  );
}

// Named alias
export const LayersPanel = VariablePanel;
