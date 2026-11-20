"use client";

import { useMemo, useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { Search, RotateCcw, Filter } from "lucide-react";
import { AnchorCard } from "@/components/AnchorCard";
import type { AnchorAttestation } from "@/lib/registry";

interface AttestedAnchorsSectionProps {
  anchors: AnchorAttestation[];
}

export function AttestedAnchorsSection({ anchors }: AttestedAnchorsSectionProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const sepParam = searchParams.get("sep") ?? "";
  const assetParam = searchParams.get("asset") ?? "";
  const countryParam = searchParams.get("country") ?? "";
  const qParam = searchParams.get("q") ?? "";

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value.trim()) {
        params.set(key, value.trim());
      } else {
        params.delete(key);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const clearAllFilters = useCallback(() => {
    router.replace(pathname, { scroll: false });
  }, [router, pathname]);

  // Extract distinct assets and countries across all anchors for the dropdowns
  const availableAssets = useMemo(() => {
    const set = new Set<string>();
    for (const a of anchors) {
      if (a.receiveAssets) {
        for (const asset of a.receiveAssets) {
          set.add(asset);
        }
      }
    }
    return Array.from(set).sort();
  }, [anchors]);

  const availableCountries = useMemo(() => {
    const set = new Set<string>();
    for (const a of anchors) {
      if (a.countries) {
        for (const c of a.countries) {
          set.add(c);
        }
      } else if (a.country) {
        set.add(a.country);
      }
    }
    return Array.from(set).sort();
  }, [anchors]);

  const filteredAnchors = useMemo(() => {
    return anchors.filter((a) => {
      // SEP filter
      if (sepParam) {
        if (sepParam === "31-served") {
          if (!a.servesSep31) return false;
        } else {
          const sepNum = Number.parseInt(sepParam, 10);
          if (Number.isInteger(sepNum)) {
            if (!a.seps.includes(sepNum)) return false;
          }
        }
      }

      // Asset filter
      if (assetParam) {
        if (!a.receiveAssets || !a.receiveAssets.includes(assetParam)) {
          return false;
        }
      }

      // Country filter
      if (countryParam) {
        const matchesCountry =
          (a.countries && a.countries.includes(countryParam)) ||
          a.country === countryParam;
        if (!matchesCountry) return false;
      }

      // Search term (domain)
      if (qParam) {
        const query = qParam.toLowerCase();
        if (!a.domain.toLowerCase().includes(query)) {
          return false;
        }
      }

      return true;
    });
  }, [anchors, sepParam, assetParam, countryParam, qParam]);

  const hasActiveFilters = Boolean(sepParam || assetParam || countryParam || qParam);

  return (
    <div className="flex flex-col gap-6">
      {/* Controls Bar */}
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-bg-subtle p-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-secondary-text">
          <Filter size={14} className="text-blue-600" /> Filter anchors
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
          {/* Domain text search */}
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary-text"
            />
            <input
              type="text"
              value={qParam}
              onChange={(e) => updateParam("q", e.target.value)}
              placeholder="Search domain..."
              aria-label="Filter anchors by domain name"
              className="w-full rounded-lg border border-border bg-card-bg py-2 pl-9 pr-3 text-sm text-primary-text placeholder:text-secondary-text/60 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* SEP filter */}
          <div>
            <label htmlFor="filter-sep" className="sr-only">
              Filter by SEP
            </label>
            <select
              id="filter-sep"
              value={sepParam}
              onChange={(e) => updateParam("sep", e.target.value)}
              className="w-full rounded-lg border border-border bg-card-bg px-3 py-2 text-sm text-primary-text focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All SEPs</option>
              <option value="31-served">SEP-31 (Served & Probed)</option>
              <option value="31">SEP-31 (Advertised)</option>
              <option value="6">SEP-6 (Deposit/Withdrawal)</option>
              <option value="24">SEP-24 (Hosted Transfer)</option>
              <option value="38">SEP-38 (Anchor Quotes)</option>
              <option value="10">SEP-10 (Authentication)</option>
              <option value="12">SEP-12 (KYC)</option>
              <option value="1">SEP-1 (stellar.toml)</option>
            </select>
          </div>

          {/* Asset filter */}
          <div>
            <label htmlFor="filter-asset" className="sr-only">
              Filter by asset
            </label>
            <select
              id="filter-asset"
              value={assetParam}
              onChange={(e) => updateParam("asset", e.target.value)}
              className="w-full rounded-lg border border-border bg-card-bg px-3 py-2 text-sm text-primary-text focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All Assets</option>
              {availableAssets.map((asset) => (
                <option key={asset} value={asset}>
                  {asset}
                </option>
              ))}
            </select>
          </div>

          {/* Country filter */}
          <div>
            <label htmlFor="filter-country" className="sr-only">
              Filter by country
            </label>
            <select
              id="filter-country"
              value={countryParam}
              onChange={(e) => updateParam("country", e.target.value)}
              className="w-full rounded-lg border border-border bg-card-bg px-3 py-2 text-sm text-primary-text focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All Countries</option>
              {availableCountries.map((country) => (
                <option key={country} value={country}>
                  {country}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Counter and clear actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-secondary-text">
          <div>
            Showing <span className="font-semibold text-primary-text">{filteredAnchors.length}</span>{" "}
            of <span className="font-semibold text-primary-text">{anchors.length}</span> anchors
          </div>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="inline-flex items-center gap-1 font-medium text-blue-600 hover:text-blue-700 hover:underline"
            >
              <RotateCcw size={12} /> Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Results Grid */}
      {filteredAnchors.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-bg-subtle p-8 text-center text-secondary-text">
          <p className="text-sm">No anchors match the selected filters.</p>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card-bg px-3 py-1.5 text-xs font-medium text-primary-text hover:bg-border/30"
            >
              <RotateCcw size={13} /> Reset all filters
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredAnchors.map((a) => (
            <AnchorCard key={a.domain} anchor={a} />
          ))}
        </div>
      )}
    </div>
  );
}
