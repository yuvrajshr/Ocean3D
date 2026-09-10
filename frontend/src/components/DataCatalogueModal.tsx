/**
 * DataCatalogueModal Component.
 *
 * Streamlined Ocean Data Catalogue modal:
 * - Clean header (no unnecessary tabs)
 * - Focused 2-category filter sidebar:
 *     1. Primary Ocean Variables (Temperature, Salinity, Current Velocity)
 *     2. Cyclone Hazard Fields (Heat Content, MLD, D26, Chlorophyll)
 * - Single available "+ Add to map..." product; all other products are informational (View Only)
 * - Reduced compact height and width to prevent any overlap with the header or timeline
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
  Lock,
  ArrowRight,
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
];

export const CYCLONE_VARIABLES = [
  { code: "heat_content", name: "Tropical Cyclone Heat Content (TCHP)", units: "kJ/cm²" },
  { code: "mixed_layer_depth", name: "Mixed Layer Depth (MLD)", units: "m" },
  { code: "d26", name: "26°C Isotherm Depth (D26)", units: "m" },
  { code: "chlorophyll", name: "Chlorophyll-a Bloom", units: "mg/m³" },
];

export const PRODUCTS: CatalogueProduct[] = [
  {
    id: "prod-001",
    title: "Global & Tropical Indian Ocean Physics Analysis",
    code: "INCOIS_TIO_PHYSICS_ANALYSIS_001",
    isModel: true,
    // Read off the live server, not aspirational: incois_argo_10d_VAM is a 1 deg
    // grid with 24 levels. 0.083 x 50 is Copernicus's spec, which the map uses
    // but the 3D column does not.
    spatialResolution: "Tropical Indian Ocean, 1.0° × 24 levels (5–2000 m)",
    coverageStart: "10 Jan 2004",
    coverageEnd: "30 Jul 2026",
    temporalFrequency: "10-day variational analysis",
    category: "primary",
    badge: "INCOIS-HYCOM Analysis",
    thumbnailGradient: "linear-gradient(135deg, #b45309, #d97706, #f59e0b, #eab308)",
    primaryVariable: "temperature",
    variables: [
      { code: "temperature", name: "Temperature" },
      { code: "salinity", name: "Salinity" },
      { code: "currents", name: "Currents" },
    ],
  },
  {
    id: "prod-002",
    title: "Bay of Bengal Cyclone Phailin Hazard Model",
    code: "INCOIS_CYCLONE_PHAILIN_OCT2013",
    isModel: true,
    spatialResolution: "Bay of Bengal (5–23°N, 78–95°E) × 50 levels",
    coverageStart: "4 Oct 2013",
    coverageEnd: "16 Oct 2013",
    temporalFrequency: "Hourly cold wake & upper thermal structure",
    category: "cyclone",
    badge: "WRF-Ocean Model",
    thumbnailGradient: "linear-gradient(135deg, #c2410c, #ea580c, #f97316, #fb923c)",
    primaryVariable: "heat_content",
    variables: [
      { code: "heat_content", name: "Heat Content" },
      { code: "mixed_layer_depth", name: "MLD" },
      { code: "d26", name: "D26" },
      { code: "chlorophyll", name: "Chlorophyll" },
    ],
  },
  {
    id: "prod-003",
    title: "Indian Ocean Biogeochemical Satellite Composite",
    code: "INCOIS_BIO_OCEAN_COLOR_DAILY",
    isModel: false,
    spatialResolution: "North Indian Ocean, 4 km optical raster",
    coverageStart: "1 Oct 2013",
    coverageEnd: "20 Oct 2013",
    temporalFrequency: "Daily composite raster",
    category: "cyclone",
    badge: "MODIS-Aqua Satellite",
    thumbnailGradient: "linear-gradient(135deg, #0f766e, #0d9488, #06b6d4)",
    primaryVariable: "chlorophyll",
    variables: [
      { code: "chlorophyll", name: "Chlorophyll-a" },
      { code: "temperature", name: "SST" },
    ],
  },
  {
    id: "prod-004",
    title: "North Indian Ocean Thermal Structure Reanalysis",
    code: "INCOIS_THERMAL_STRUCTURE_DAILY",
    isModel: true,
    spatialResolution: "North Indian Ocean, 0.083° × 50 depth levels",
    coverageStart: "1 Oct 2013",
    coverageEnd: "20 Oct 2013",
    temporalFrequency: "Daily multi-layer analysis",
    category: "primary",
    badge: "INCOIS-TIO Simulation",
    thumbnailGradient: "linear-gradient(135deg, #4338ca, #4f46e5, #7c3aed)",
    primaryVariable: "d26",
    variables: [
      { code: "d26", name: "D26" },
      { code: "mixed_layer_depth", name: "MLD" },
    ],
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

  // Filter products based on search and category/variable
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

  // Determine WHICH single product has the active "+ Add to map..." action
  // If a cyclone variable or category is chosen, Cyclone Phailin model is the 1 available to add.
  // Otherwise, the Primary Physics model is the 1 available to add. All others remain view-only.
  const availableProductId = useMemo(() => {
    const isCycloneSelected =
      selectedCategory === "cyclone" ||
      (selectedVariableCode && CYCLONE_VARIABLES.some((v) => v.code === selectedVariableCode));
    return isCycloneSelected ? "prod-002" : "prod-001";
  }, [selectedCategory, selectedVariableCode]);

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
    const targetVar = selectedVariableCode || product.primaryVariable;
    onAddLayer(targetVar);

    setToastMessage(`Added layer to map`);
    setTimeout(() => {
      setToastMessage(null);
      handleClose();
    }, 350);
  };

  // Close modal when pressing Escape key
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
        {/* Streamlined Modal Header */}
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

        {/* Modal Main Body */}
        <div className="catalogue-modal-body">
          {/* Left Sidebar: 2 Essential Categories (Variables & Cyclone) */}
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
              {/* Search input */}
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
              </div>

              {/* 1. Primary Ocean Variables */}
              <div className="catalogue-filter-section">
                <div
                  onClick={() => {
                    setSelectedCategory((prev) => (prev === "primary" ? "all" : "primary"));
                    setSelectedVariableCode(null);
                  }}
                  className={`catalogue-section-header-btn ${selectedCategory === "primary" ? "catalogue-section-header-btn--active" : ""}`}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Layers className="w-3.5 h-3.5" style={{ width: 14, height: 14, color: "#38bdf8" }} />
                    Ocean Variables (3D)
                  </span>
                  <span className="catalogue-count-badge">3</span>
                </div>

                <div className="catalogue-options-list">
                  {PRIMARY_VARIABLES.map((v) => {
                    const isSelected = selectedVariableCode === v.code;
                    return (
                      <button
                        type="button"
                        key={v.code}
                        aria-pressed={isSelected}
                        onClick={() => {
                          setSelectedCategory("primary");
                          setSelectedVariableCode((prev) => (prev === v.code ? null : v.code));
                        }}
                        className={`catalogue-option-item ${isSelected ? "catalogue-option-item--selected" : ""}`}
                        >
                        <span className="catalogue-option-label">{v.name}</span>
                        <span className="catalogue-option-unit">{v.units}</span>
                        {isSelected && <Check className="w-3 h-3" style={{ width: 12, height: 12, color: "#22d3ee" }} />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 2. Cyclone Hazard Fields */}
              <div className="catalogue-filter-section">
                <div
                  onClick={() => {
                    setSelectedCategory((prev) => (prev === "cyclone" ? "all" : "cyclone"));
                    setSelectedVariableCode(null);
                  }}
                  className={`catalogue-section-header-btn ${selectedCategory === "cyclone" ? "catalogue-section-header-btn--active" : ""}`}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Flame className="w-3.5 h-3.5" style={{ width: 14, height: 14, color: "#f97316" }} />
                    Cyclone Hazard Fields
                  </span>
                  <span className="catalogue-count-badge">4</span>
                </div>

                <div className="catalogue-options-list">
                  {CYCLONE_VARIABLES.map((v) => {
                    const isSelected = selectedVariableCode === v.code;
                    return (
                      <button
                        type="button"
                        key={v.code}
                        aria-pressed={isSelected}
                        onClick={() => {
                          setSelectedCategory("cyclone");
                          setSelectedVariableCode((prev) => (prev === v.code ? null : v.code));
                        }}
                        className={`catalogue-option-item ${isSelected ? "catalogue-option-item--selected" : ""}`}
                        >
                        <span className="catalogue-option-label">{v.name}</span>
                        <span className="catalogue-option-unit">{v.units}</span>
                        {isSelected && <Check className="w-3 h-3" style={{ width: 12, height: 12, color: "#22d3ee" }} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </aside>

          {/* Right Main Area: Products */}
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
                1 operational layer available to map · reference models for inspection
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
                  const isAvailableToAdd = product.id === availableProductId;
                  const isAnyVarActive = product.variables.some((v) => activeLayers.includes(v.code));

                  return (
                    <div
                      key={product.id}
                      className={`catalogue-card ${isAvailableToAdd ? "catalogue-card--available" : "catalogue-card--readonly"}`}
                    >
                      {/* Compact Card Thumbnail */}
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

                        {/* ONLY the single available product displays "Add to Map" */}
                        {isAvailableToAdd ? (
                          <button
                            type="button"
                            onClick={() => handleAddProduct(product)}
                            className="catalogue-add-to-map-btn"
                            title={`Add ${product.title} to 3D map`}
                          >
                            <span className="catalogue-add-btn__icon">
                              <Plus className="w-3.5 h-3.5" style={{ width: 14, height: 14, strokeWidth: 2.5 }} />
                            </span>
                            <span className="catalogue-add-btn__label">Add to Map</span>
                            <ArrowRight className="catalogue-add-btn__arrow" style={{ width: 13, height: 13, strokeWidth: 2 }} />
                          </button>
                        ) : (
                          <div className="catalogue-readonly-badge">
                            <Lock className="w-3 h-3" style={{ width: 11, height: 11 }} />
                            <span>Reference Dataset</span>
                          </div>
                        )}
                      </div>

                      {/* Card Details Body */}
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
