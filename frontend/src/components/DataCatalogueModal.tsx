/**
 * Data catalogue modal: products grouped into ocean variables and cyclone hazard
 * fields, with search, and an "Add to map" button on each product.
 */

import React, { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Search,
  Filter,
  Globe,
  Plus,
  Check,
  Flame,
  Layers,
} from "lucide-react";
import "../styles/data-catalogue-modal.css";

export interface CatalogueProduct {
  id: string;
  title: string;
  code: string;
  isModel: boolean;
  spatialResolution: string;
  coverageStart: string;
  coverageEnd: string;
  temporalFrequency: string;
  category: "primary" | "cyclone";
  badge?: string;
  thumbnailGradient: string;
  primaryVariable: string;
  variables: Array<{ code: string; name: string }>;
}

export const PRIMARY_VARIABLES = [
  { code: "temperature", name: "Sea Water Temperature", units: "°C" },
  { code: "salinity", name: "Practical Salinity", units: "PSU" },
  { code: "currents", name: "Current Velocity", units: "m/s" },
  { code: "ph", name: "Ocean Acidity (pH)", units: "pH" },
  { code: "zooplankton", name: "Zooplankton Biomass", units: "g/m²" },
];

export const CYCLONE_VARIABLES = [
  { code: "wave_height", name: "Significant Wave Height (VHM0)", units: "m" },
  { code: "heat_content", name: "Tropical Cyclone Heat Content (TCHP)", units: "kJ/cm²" },
  { code: "mixed_layer_depth", name: "Mixed Layer Depth (MLD)", units: "m" },
  { code: "d26", name: "26°C Isotherm Depth (D26)", units: "m" },
  { code: "chlorophyll", name: "Chlorophyll-a Bloom", units: "mg/m³" },
];

export const PRODUCTS: CatalogueProduct[] = [
  // --- Ocean variables (3D) ---
  {
    id: "prod-temp",
    title: "Sea Water Temperature (3D Analysis)",
    code: "INCOIS_TIO_TEMP_3D",
    isModel: true,
    spatialResolution: "Tropical Indian Ocean, 1.0° × 24 levels (5–2000 m)",
    coverageStart: "10 Jan 2004",
    coverageEnd: "30 Jul 2026",
    temporalFrequency: "10-day variational analysis",
    category: "primary",
    badge: "INCOIS-HYCOM",
    thumbnailGradient: "linear-gradient(135deg, #9a3412, #c2410c, #ea580c, #f97316)",
    primaryVariable: "temperature",
    variables: [{ code: "temperature", name: "Temperature" }],
  },
  {
    id: "prod-sal",
    title: "Practical Salinity (3D Analysis)",
    code: "INCOIS_TIO_SAL_3D",
    isModel: true,
    spatialResolution: "Tropical Indian Ocean, 1.0° × 24 levels (5–2000 m)",
    coverageStart: "10 Jan 2004",
    coverageEnd: "30 Jul 2026",
    temporalFrequency: "10-day variational analysis",
    category: "primary",
    badge: "INCOIS-HYCOM",
    thumbnailGradient: "linear-gradient(135deg, #1e3a8a, #1d4ed8, #2563eb, #60a5fa)",
    primaryVariable: "salinity",
    variables: [{ code: "salinity", name: "Salinity" }],
  },
  {
    id: "prod-curr",
    title: "Ocean Current Velocity & Drift",
    code: "INCOIS_TIO_CURRENTS",
    isModel: true,
    spatialResolution: "Tropical Indian Ocean, 1.0° × surface vector",
    coverageStart: "10 Jan 2004",
    coverageEnd: "30 Jul 2026",
    temporalFrequency: "10-day geostrophic analysis",
    category: "primary",
    badge: "INCOIS-HYCOM",
    thumbnailGradient: "linear-gradient(135deg, #065f46, #047857, #059669, #34d399)",
    primaryVariable: "currents",
    variables: [{ code: "currents", name: "Current Velocity" }],
  },
  {
    id: "prod-ph",
    title: "Global Ocean Acidity (pH)",
    code: "CMEMS_MOD_GLO_BGC_CAR_DAILY",
    isModel: true,
    spatialResolution: "Global, 0.25° × 50 depth levels (0.5–5728 m)",
    coverageStart: "1 Nov 2021",
    coverageEnd: "19 Sep 2026",
    temporalFrequency: "Daily global biogeochemical analysis",
    category: "primary",
    badge: "Copernicus BGC",
    thumbnailGradient: "linear-gradient(135deg, #be123c, #e11d48, #fb7185, #38bdf8)",
    primaryVariable: "ph",
    variables: [{ code: "ph", name: "Ocean Acidity (pH)" }],
  },
  {
    id: "prod-zoo",
    title: "Global Ocean Zooplankton Biomass",
    code: "CMEMS_MOD_GLO_BGC_MY_LMTL_P1D-I",
    isModel: true,
    spatialResolution: "Global, 0.083° × surface biomass",
    coverageStart: "1 Jan 1998",
    coverageEnd: "19 Sep 2026",
    temporalFrequency: "Daily global biomass hindcast & forecast",
    category: "primary",
    badge: "Copernicus SEAPODYM",
    thumbnailGradient: "linear-gradient(135deg, #064e3b, #047857, #10b981, #6ee7b7)",
    primaryVariable: "zooplankton",
    variables: [{ code: "zooplankton", name: "Zooplankton Biomass" }],
  },

  // --- Cyclone hazard fields ---
  {
    id: "prod-wave",
    title: "Significant Wave Height (VHM0)",
    code: "CMEMS_MOD_GLO_WAV_MY_0.2DEG_PT3H-I",
    isModel: true,
    spatialResolution: "Global, 0.2° × surface wave spectrum",
    coverageStart: "1 Jan 1980",
    coverageEnd: "31 May 2026",
    temporalFrequency: "3-hourly global wave reanalysis",
    category: "cyclone",
    badge: "Copernicus WAVERYS",
    thumbnailGradient: "linear-gradient(135deg, #0c2340, #004b87, #0284c7, #38bdf8)",
    primaryVariable: "wave_height",
    variables: [{ code: "wave_height", name: "Significant Wave Height" }],
  },
  {
    id: "prod-tchp",
    title: "Tropical Cyclone Heat Content (TCHP)",
    code: "INCOIS_CYCLONE_PHAILIN_OCT2013",
    isModel: true,
    spatialResolution: "Bay of Bengal (5–23°N, 78–95°E) × upper ocean",
    coverageStart: "4 Oct 2013",
    coverageEnd: "16 Oct 2013",
    temporalFrequency: "Hourly cold wake & upper thermal structure",
    category: "cyclone",
    badge: "WRF-Ocean Model",
    thumbnailGradient: "linear-gradient(135deg, #c2410c, #ea580c, #f97316, #fb923c)",
    primaryVariable: "heat_content",
    variables: [{ code: "heat_content", name: "Heat Content" }],
  },
  {
    id: "prod-mld",
    title: "Global Ocean Mixed Layer Depth (MLD)",
    code: "CMEMS_MOD_GLO_PHY_MY_0.083DEG_P1D-M",
    isModel: true,
    spatialResolution: "Global, 0.083° × surface scalar (depth)",
    coverageStart: "1 Jan 1993",
    coverageEnd: "23 Jun 2026",
    temporalFrequency: "Daily global ocean reanalysis",
    category: "cyclone",
    badge: "Copernicus GLORYS12",
    thumbnailGradient: "linear-gradient(135deg, #0f4c81, #1565c0, #1976d2, #42a5f5)",
    primaryVariable: "mixed_layer_depth",
    variables: [{ code: "mixed_layer_depth", name: "Mixed Layer Depth" }],
  },
  {
    id: "prod-d26",
    title: "26°C Isotherm Depth (D26)",
    code: "INCOIS_PHAILIN_D26_DAILY",
    isModel: true,
    spatialResolution: "North Indian Ocean, 0.083° × 50 depth levels",
    coverageStart: "1 Oct 2013",
    coverageEnd: "20 Oct 2013",
    temporalFrequency: "Daily multi-layer analysis",
    category: "cyclone",
    badge: "INCOIS-TIO Model",
    thumbnailGradient: "linear-gradient(135deg, #4338ca, #4f46e5, #7c3aed, #a855f7)",
    primaryVariable: "d26",
    variables: [{ code: "d26", name: "D26 Depth" }],
  },
  {
    id: "prod-chla",
    title: "Chlorophyll-a Bloom & Cold Wake",
    code: "INCOIS_BIO_OCEAN_COLOR_DAILY",
    isModel: true,
    spatialResolution: "North Indian Ocean, 4 km optical raster",
    coverageStart: "1 Oct 2013",
    coverageEnd: "20 Oct 2013",
    temporalFrequency: "Daily composite raster",
    category: "cyclone",
    badge: "MODIS-Aqua Satellite",
    thumbnailGradient: "linear-gradient(135deg, #0f766e, #0d9488, #06b6d4, #22d3ee)",
    primaryVariable: "chlorophyll",
    variables: [{ code: "chlorophyll", name: "Chlorophyll-a" }],
  },
];

interface DataCatalogueModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddLayer: (variableKey: string) => void;
  activeLayers?: string[];
}

export const DataCatalogueModal: React.FC<DataCatalogueModalProps> = ({
  isOpen,
  onClose,
  onAddLayer,
  activeLayers = [],
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<"all" | "primary" | "cyclone">("all");
  const [selectedVariableCode, setSelectedVariableCode] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const handleClearFilters = () => {
    setSearchQuery("");
    setSelectedCategory("all");
    setSelectedVariableCode(null);
  };

  // Filter the sidebar variables by the search text.
  const filteredPrimaryVars = useMemo(() => {
    if (!searchQuery.trim()) return PRIMARY_VARIABLES;
    const q = searchQuery.toLowerCase();
    return PRIMARY_VARIABLES.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        v.code.toLowerCase().includes(q) ||
        v.units.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  const filteredCycloneVars = useMemo(() => {
    if (!searchQuery.trim()) return CYCLONE_VARIABLES;
    const q = searchQuery.toLowerCase();
    return CYCLONE_VARIABLES.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        v.code.toLowerCase().includes(q) ||
        v.units.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  // Filter products by search text, category and variable.
  const filteredProducts = useMemo(() => {
    return PRODUCTS.filter((p) => {
      // Text search
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = p.title.toLowerCase().includes(q);
        const matchCode = p.code.toLowerCase().includes(q);
        const matchVars = p.variables.some((v) => v.name.toLowerCase().includes(q) || v.code.toLowerCase().includes(q));
        if (!matchTitle && !matchCode && !matchVars) return false;
      }

      // Category filter
      if (selectedCategory !== "all" && p.category !== selectedCategory) {
        return false;
      }

      // Variable filter
      if (selectedVariableCode) {
        const hasVar = p.variables.some((v) => v.code === selectedVariableCode);
        if (!hasVar) return false;
      }

      return true;
    });
  }, [searchQuery, selectedCategory, selectedVariableCode]);



  const [isClosing, setIsClosing] = useState(false);
  const [shouldRender, setShouldRender] = useState(isOpen);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      setIsClosing(false);
    } else if (shouldRender) {
      setIsClosing(true);
      const timer = window.setTimeout(() => {
        setShouldRender(false);
        setIsClosing(false);
      }, 220);
      return () => window.clearTimeout(timer);
    }
  }, [isOpen, shouldRender]);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
    }, 200);
  };

  const handleAddProduct = (product: CatalogueProduct) => {
    const targetVar =
      selectedVariableCode && product.variables.some((v) => v.code === selectedVariableCode)
        ? selectedVariableCode
        : product.primaryVariable;
    onAddLayer(targetVar);

    setToastMessage(`Added layer to map`);
    setTimeout(() => {
      setToastMessage(null);
      handleClose();
    }, 350);
  };

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  if (!shouldRender) return null;

  const modalContent = (
    <div
      id="ocean3d-data-catalogue-modal"
      className={`catalogue-modal-overlay ${isClosing ? "catalogue-modal-overlay--closing" : "catalogue-modal-overlay--open"}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleClose();
        }
      }}
    >
      <div
        className={`catalogue-modal-box ${isClosing ? "catalogue-modal-box--closing" : "catalogue-modal-box--open"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="catalogue-modal-topbar">
          <div className="catalogue-modal-title-wrap">
            <span className="catalogue-modal-title-text">Ocean 3D Data Catalogue</span>
            <span className="catalogue-modal-sub-badge">INCOIS ERDDAP</span>
          </div>

          <button
            type="button"
            id="btn-close-catalogue"
            onClick={(e) => {
              e.stopPropagation();
              handleClose();
            }}
            className="catalogue-icon-btn catalogue-icon-btn--close"
            title="Close Catalogue (Esc)"
          >
            <X className="w-4 h-4" style={{ width: 18, height: 18 }} />
          </button>
        </div>

        <div className="catalogue-modal-body">
          {/* sidebar */}
          <aside className="catalogue-sidebar">
            <div className="catalogue-sidebar-header">
              <span className="catalogue-sidebar-title">
                <Filter className="w-3.5 h-3.5" style={{ width: 14, height: 14, color: "#22d3ee" }} />
                Filters
              </span>
              <button
                type="button"
                onClick={handleClearFilters}
                className="catalogue-filter-clear-btn"
              >
                Reset
              </button>
            </div>

            <div className="catalogue-sidebar-content">
              <div className="catalogue-search-wrapper">
                <Search className="catalogue-search-icon" style={{ width: 13, height: 13 }} />
                <input
                  id="search-catalogue-input"
                  type="text"
                  placeholder="Search catalogue..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="catalogue-search-input"
                />
                {searchQuery.trim().length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="catalogue-search-clear-btn"
                    title="Clear search"
                  >
                    <X style={{ width: 12, height: 12 }} />
                  </button>
                )}
              </div>

              {/* ocean variables */}
              <div className="catalogue-filter-section">
                <div
                  onClick={() => {
                    setSelectedCategory((prev) => (prev === "primary" ? "all" : "primary"));
                    setSelectedVariableCode(null);
                  }}
                  className={`catalogue-section-header-btn ${selectedCategory === "primary" ? "catalogue-section-header-btn--active" : ""}`}
                  title="Filter by Ocean Variables (3D)"
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <Layers className="w-3.5 h-3.5" style={{ width: 14, height: 14, color: "#38bdf8" }} />
                    Ocean Variables (3D)
                  </span>
                  <span className="catalogue-count-badge">{filteredPrimaryVars.length}</span>
                </div>

                <div className="catalogue-options-list">
                  {filteredPrimaryVars.length === 0 ? (
                    <div className="catalogue-option-empty">No matching variables</div>
                  ) : (
                    filteredPrimaryVars.map((v) => {
                      const isSelected = selectedVariableCode === v.code;
                      return (
                        <button
                          type="button"
                          key={v.code}
                          aria-pressed={isSelected}
                          title={`${v.name} (${v.units})`}
                          onClick={() => {
                            setSelectedCategory("primary");
                            setSelectedVariableCode((prev) => (prev === v.code ? null : v.code));
                          }}
                          className={`catalogue-option-item ${isSelected ? "catalogue-option-item--selected" : ""}`}
                        >
                          <span className="catalogue-option-label">{v.name}</span>
                          <span className="catalogue-option-unit">{v.units}</span>
                          {isSelected && (
                            <Check
                              className="w-3.5 h-3.5"
                              style={{ width: 13, height: 13, color: "var(--rt-copper, #e59858)", strokeWidth: 3 }}
                            />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {/* cyclone hazard fields */}
              <div className="catalogue-filter-section">
                <div
                  onClick={() => {
                    setSelectedCategory((prev) => (prev === "cyclone" ? "all" : "cyclone"));
                    setSelectedVariableCode(null);
                  }}
                  className={`catalogue-section-header-btn ${selectedCategory === "cyclone" ? "catalogue-section-header-btn--active" : ""}`}
                  title="Filter by Cyclone Hazard Fields"
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <Flame className="w-3.5 h-3.5" style={{ width: 14, height: 14, color: "#f97316" }} />
                    Cyclone Hazard Fields
                  </span>
                  <span className="catalogue-count-badge">{filteredCycloneVars.length}</span>
                </div>

                <div className="catalogue-options-list">
                  {filteredCycloneVars.length === 0 ? (
                    <div className="catalogue-option-empty">No matching variables</div>
                  ) : (
                    filteredCycloneVars.map((v) => {
                      const isSelected = selectedVariableCode === v.code;
                      return (
                        <button
                          type="button"
                          key={v.code}
                          aria-pressed={isSelected}
                          title={`${v.name} (${v.units})`}
                          onClick={() => {
                            setSelectedCategory("cyclone");
                            setSelectedVariableCode((prev) => (prev === v.code ? null : v.code));
                          }}
                          className={`catalogue-option-item ${isSelected ? "catalogue-option-item--selected" : ""}`}
                        >
                          <span className="catalogue-option-label">{v.name}</span>
                          <span className="catalogue-option-unit">{v.units}</span>
                          {isSelected && (
                            <Check
                              className="w-3.5 h-3.5"
                              style={{ width: 13, height: 13, color: "var(--rt-copper, #e59858)", strokeWidth: 3 }}
                            />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </aside>

          {/* products */}
          <main className="catalogue-products-main">
            {toastMessage && (
              <div className="catalogue-toast">
                <Check className="w-4 h-4" style={{ width: 16, height: 16, strokeWidth: 3 }} />
                {toastMessage}
              </div>
            )}

            <div className="catalogue-products-header">
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <h1 className="catalogue-products-title">Products</h1>
                <span className="catalogue-products-count">{filteredProducts.length}</span>
              </div>
              <div className="catalogue-products-subtitle">
                {filteredProducts.length} operational layer{filteredProducts.length !== 1 ? "s" : ""} available to add to map
              </div>
            </div>

            {filteredProducts.length === 0 ? (
              <div className="catalogue-empty-state">
                <p style={{ color: "#cbd5e1", fontSize: 13 }}>No products match this selection.</p>
                <button
                  type="button"
                  onClick={handleClearFilters}
                  className="catalogue-btn-reset"
                >
                  Reset filters
                </button>
              </div>
            ) : (
              <div className="catalogue-products-grid">
                {filteredProducts.map((product) => {
                  const isAnyVarActive = product.variables.some((v) => activeLayers.includes(v.code));

                  return (
                    <div
                      key={product.id}
                      className="catalogue-card catalogue-card--available"
                    >
                      <div className="catalogue-card-thumb">
                        <div
                          className="catalogue-card-thumb-bg"
                          style={{ background: product.thumbnailGradient }}
                        />

                        <div className="catalogue-thumb-icon">
                          <Globe className="w-3 h-3" style={{ width: 12, height: 12 }} />
                        </div>

                        <div className="catalogue-thumb-badge">
                          {product.badge}
                          {isAnyVarActive && " · Active"}
                        </div>

                        {/* every product can be added to the map */}
                        <button
                          type="button"
                          onClick={() => handleAddProduct(product)}
                          className="catalogue-add-to-map-btn"
                          title={`Add ${product.title} to 3D map`}
                        >
                          <span className="catalogue-add-btn__icon">
                            <Plus className="w-3.5 h-3.5" style={{ width: 14, height: 14, strokeWidth: 2.5 }} />
                          </span>
                          <span className="catalogue-add-btn__label">Add to map</span>
                        </button>
                      </div>

                      <div className="catalogue-card-body">
                        <div>
                          <h3 className="catalogue-card-title">{product.title}</h3>
                          <div className="catalogue-card-code">{product.code}</div>
                          <div className="catalogue-card-spatial">{product.spatialResolution}</div>
                        </div>

                        <div className="catalogue-card-footer">
                          <div className="catalogue-card-var-tags">
                            {product.variables.map((v, i) => {
                              const isMatched = selectedVariableCode === v.code;
                              const isCurrentlyActive = activeLayers.includes(v.code);
                              return (
                                <span
                                  key={v.code}
                                  className={`catalogue-card-var-tag ${isMatched ? "catalogue-card-var-tag--matched" : ""} ${
                                    isCurrentlyActive ? "catalogue-card-var-tag--active" : ""
                                  }`}
                                >
                                  {v.name}
                                  {i < product.variables.length - 1 ? " · " : ""}
                                </span>
                              );
                            })}
                          </div>
                          <div className="catalogue-card-temporal">{product.temporalFrequency}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined"
    ? createPortal(modalContent, document.body)
    : modalContent;
};
