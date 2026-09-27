/**
 * NAVALERT PLACE SEARCH SERVICE & PROVIDER ARCHITECTURE
 * 
 * Provides a provider-independent search and geocoding abstraction.
 * Pluggable Providers:
 *   - MapboxSearchProvider (requires access token)
 *   - NominatimSearchProvider (OpenStreetMap / open access)
 *   - PhotonSearchProvider (Komoot OSM / open access)
 * 
 * Architecture:
 *   Place Search Service (NavalertSearchService)
 *        ↓
 *   Search Provider Interface
 *        ↓
 *   [MapboxSearchProvider, NominatimSearchProvider, PhotonSearchProvider]
 * 
 * Fully decoupled from UI and routing layers.
 * Supports UMD (Browser window and Node.js CommonJS/ESM).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const exports = factory();
    root.NavalertSearch = exports;
    root.NavalertSearchService = exports.NavalertSearchService;
    root.MapboxSearchProvider = exports.MapboxSearchProvider;
    root.NominatimSearchProvider = exports.NominatimSearchProvider;
    root.PhotonSearchProvider = exports.PhotonSearchProvider;
    root.validateCoordinates = exports.validateCoordinates;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // ===================================================================
  // 1. COORDINATE VALIDATION & GEOMETRIC UTILITIES
  // ===================================================================

  /**
   * Validates WGS84 geographic coordinates.
   * Latitude must be between -90 and +90.
   * Longitude must be between -180 and +180.
   * Both must be finite numbers.
   * 
   * @param {any} lat 
   * @param {any} lon 
   * @returns {{ valid: boolean, lat: number|null, lon: number|null, error?: string }}
   */
  function validateCoordinates(lat, lon) {
    const numLat = typeof lat === 'string' ? parseFloat(lat) : Number(lat);
    const numLon = typeof lon === 'string' ? parseFloat(lon) : Number(lon);

    if (lat === null || lat === undefined || lon === null || lon === undefined) {
      return { valid: false, lat: null, lon: null, error: 'Coordinates cannot be null or undefined' };
    }

    if (isNaN(numLat) || isNaN(numLon) || !isFinite(numLat) || !isFinite(numLon)) {
      return { valid: false, lat: null, lon: null, error: 'Coordinates must be valid finite numbers' };
    }

    if (numLat < -90.0 || numLat > 90.0) {
      return { valid: false, lat: null, lon: null, error: `Latitude ${numLat} out of bounds [-90, 90]` };
    }

    if (numLon < -180.0 || numLon > 180.0) {
      return { valid: false, lat: null, lon: null, error: `Longitude ${numLon} out of bounds [-180, 180]` };
    }

    return { valid: true, lat: numLat, lon: numLon };
  }

  function computeDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function normalizeQuery(q) {
    return (q || '').trim().replace(/\s+/g, ' ');
  }

  function getCategoryIcon(cat, type) {
    cat = (cat || '').toLowerCase();
    type = (type || '').toLowerCase();
    if (cat === 'railway' || type.includes('railway') || type === 'station') return '🚉';
    if (type.includes('bus') || cat.includes('bus')) return '🚌';
    if (cat === 'tourism' || type === 'attraction' || type === 'monument' || type === 'castle' || type === 'fort') return '🏛️';
    if (cat === 'amenity' && (type === 'hospital' || type === 'clinic')) return '🏥';
    if (cat === 'amenity' && (type.includes('school') || type.includes('college') || type.includes('university'))) return '🎓';
    if (cat === 'highway' || type === 'road' || type === 'street' || type === 'trunk') return '🛣️';
    if (type === 'airport' || cat === 'aeroway') return '✈️';
    if (cat === 'place' && (type === 'city' || type === 'town')) return '🏙️';
    if (cat === 'place' && (type === 'suburb' || type === 'neighbourhood' || type === 'quarter')) return '🏘️';
    if (cat === 'place' && (type === 'village' || type === 'hamlet')) return '🏡';
    return '📍';
  }

  function formatAddressContext(item) {
    const addr = item.address || {};
    const name = item.name || (item.display_name ? item.display_name.split(',')[0].trim() : 'Location');

    const loc = addr.suburb || addr.neighbourhood || addr.residential || addr.quarter || addr.subdivision || '';
    const city = addr.city || addr.town || addr.village || addr.municipality || addr.city_district || '';
    const district = addr.state_district || addr.district || addr.county || '';
    const state = addr.state || '';
    const country = addr.country || '';

    const parts = [];
    if (loc && loc.toLowerCase() !== name.toLowerCase()) parts.push(loc);
    if (city && city.toLowerCase() !== name.toLowerCase() && (!loc || city.toLowerCase() !== loc.toLowerCase())) parts.push(city);
    if (district && district.toLowerCase() !== name.toLowerCase() && district.toLowerCase() !== city.toLowerCase()) {
      parts.push(district.toLowerCase().includes('dist') ? district : district + ' Dist');
    }
    if (state && state.toLowerCase() !== name.toLowerCase()) parts.push(state);

    let context = parts.join(', ');
    if (!context) {
      context = item.display_name ? item.display_name.split(',').slice(1, 4).join(', ').trim() : '';
    }

    return {
      primaryName: name,
      context: context,
      localityOrCity: loc || city || district || state,
      locality: loc,
      city: city,
      district: district,
      state: state,
      country: country
    };
  }

  // ===================================================================
  // 2. SEARCH PROVIDER: NOMINATIM (OpenStreetMap)
  // ===================================================================

  const NominatimSearchProvider = {
    name: 'nominatim',
    baseUrl: 'https://nominatim.openstreetmap.org/search',

    isConfigured() {
      return true; // Open access API, does not require API key
    },

    async search(query, options) {
      options = options || {};
      const limit = options.limit || 6;
      const url = this.baseUrl + '?format=jsonv2&addressdetails=1&limit=' + limit +
        '&countrycodes=in&q=' + encodeURIComponent(query);

      const headers = { 'Accept': 'application/json' };
      if (typeof navigator === 'undefined') {
        headers['User-Agent'] = 'NavalertCollegeProject/1.0';
      }

      const res = await fetch(url, {
        signal: options.signal,
        headers: headers
      });

      if (!res.ok) {
        throw new Error('Nominatim HTTP error ' + res.status);
      }

      const data = await res.json();
      if (!Array.isArray(data)) return [];

      const results = [];
      for (const item of data) {
        const normalized = this.normalize(item);
        if (normalized) {
          results.push(normalized);
        }
      }
      return results;
    },

    normalize(item) {
      if (!item || typeof item !== 'object') return null;
      const coordCheck = validateCoordinates(item.lat, item.lon);
      if (!coordCheck.valid) return null;

      const formatted = formatAddressContext(item);
      const cat = (item.category || '').toLowerCase();
      const type = (item.type || '').toLowerCase();
      const addr = item.address || {};

      return {
        provider: 'nominatim',
        primaryName: formatted.primaryName,
        displayName: item.display_name || formatted.primaryName,
        label: item.display_name || (formatted.primaryName + (formatted.context ? ', ' + formatted.context : '')),
        lat: coordCheck.lat,
        lon: coordCheck.lon,
        category: cat,
        type: type,
        icon: getCategoryIcon(cat, type),
        context: formatted.context,
        localityOrCity: formatted.localityOrCity,
        locality: formatted.locality,
        city: formatted.city,
        district: formatted.district,
        state: formatted.state,
        country: formatted.country || 'India',
        postcode: addr.postcode || '',
        importance: parseFloat(item.importance) || 0.5,
        raw: item
      };
    }
  };

  // ===================================================================
  // 3. SEARCH PROVIDER: PHOTON (Komoot / OSM Elasticsearch)
  // ===================================================================

  const PhotonSearchProvider = {
    name: 'photon',
    baseUrl: 'https://photon.komoot.io/api/',

    isConfigured() {
      return true; // Open access API, does not require API key
    },

    async search(query, options) {
      options = options || {};
      const limit = options.limit || 6;
      let url = this.baseUrl + '?q=' + encodeURIComponent(query) + '&limit=' + limit;

      if (options.biasCoords && options.biasCoords.lat && options.biasCoords.lon) {
        url += '&lat=' + options.biasCoords.lat + '&lon=' + options.biasCoords.lon;
      }

      const headers = { 'Accept': 'application/json' };
      if (typeof navigator === 'undefined') {
        headers['User-Agent'] = 'NavalertCollegeProject/1.0';
      }

      const res = await fetch(url, {
        signal: options.signal,
        headers: headers
      });

      if (!res.ok) {
        throw new Error('Photon HTTP error ' + res.status);
      }

      const data = await res.json();
      if (!data || !Array.isArray(data.features)) return [];

      const results = [];
      for (const f of data.features) {
        const normalized = this.normalize(f);
        if (normalized) {
          results.push(normalized);
        }
      }
      return results;
    },

    normalize(f) {
      if (!f || typeof f !== 'object') return null;
      const p = f.properties || {};
      const coords = (f.geometry && Array.isArray(f.geometry.coordinates)) ? f.geometry.coordinates : null;
      if (!coords || coords.length < 2) return null;

      // GeoJSON coordinates format is [longitude, latitude]
      const coordCheck = validateCoordinates(coords[1], coords[0]);
      if (!coordCheck.valid) return null;

      const item = {
        name: p.name,
        display_name: [p.name, p.district || p.county, p.city, p.state, p.country].filter(Boolean).join(', '),
        category: p.osm_key,
        type: p.osm_value,
        address: {
          suburb: p.locality || p.district,
          city: p.city,
          state_district: p.county || p.district,
          state: p.state,
          country: p.country,
          postcode: p.postcode
        }
      };

      const formatted = formatAddressContext(item);
      const cat = (p.osm_key || '').toLowerCase();
      const type = (p.osm_value || '').toLowerCase();

      return {
        provider: 'photon',
        primaryName: formatted.primaryName,
        displayName: item.display_name || formatted.primaryName,
        label: item.display_name || (formatted.primaryName + (formatted.context ? ', ' + formatted.context : '')),
        lat: coordCheck.lat,
        lon: coordCheck.lon,
        category: cat,
        type: type,
        icon: getCategoryIcon(cat, type),
        context: formatted.context,
        localityOrCity: formatted.localityOrCity,
        locality: formatted.locality,
        city: formatted.city,
        district: formatted.district,
        state: formatted.state,
        country: formatted.country || 'India',
        postcode: p.postcode || '',
        importance: 0.5,
        raw: f
      };
    }
  };

  // ===================================================================
  // 4. SEARCH PROVIDER: MAPBOX SEARCH (Geocoding v5 / Search Box API)
  // ===================================================================

  const MapboxSearchProvider = (function () {
    let accessToken = '';

    // Isolated Configuration Point
    function resolveInitialToken() {
      if (typeof process !== 'undefined' && process.env && process.env.MAPBOX_ACCESS_TOKEN) {
        return process.env.MAPBOX_ACCESS_TOKEN;
      }
      if (typeof window !== 'undefined') {
        if (window.NAVALERT_MAPBOX_TOKEN) return window.NAVALERT_MAPBOX_TOKEN;
        try {
          const stored = window.localStorage.getItem('navalert_mapbox_token');
          if (stored) return stored;
        } catch (_) {}
      }
      return '';
    }

    accessToken = resolveInitialToken();

    return {
      name: 'mapbox',
      baseUrl: 'https://api.mapbox.com/geocoding/v5/mapbox.places',

      setAccessToken(token) {
        accessToken = (token || '').trim();
        if (typeof window !== 'undefined') {
          window.NAVALERT_MAPBOX_TOKEN = accessToken;
          try {
            if (accessToken) {
              window.localStorage.setItem('navalert_mapbox_token', accessToken);
            } else {
              window.localStorage.removeItem('navalert_mapbox_token');
            }
          } catch (_) {}
        }
      },

      getAccessToken() {
        return accessToken;
      },

      isConfigured() {
        return Boolean(
          accessToken &&
          accessToken.length > 10 &&
          !accessToken.startsWith('PASTE_') &&
          (accessToken.startsWith('pk.') || accessToken.startsWith('sk.'))
        );
      },

      async search(query, options) {
        options = options || {};
        if (!this.isConfigured()) {
          const err = new Error('MapboxSearchProvider is not configured: MAPBOX_ACCESS_TOKEN is missing or unconfigured.');
          err.code = 'PROVIDER_NOT_CONFIGURED';
          throw err;
        }

        const limit = Math.min(options.limit || 5, 10);
        let url = `${this.baseUrl}/${encodeURIComponent(query)}.json?access_token=${encodeURIComponent(accessToken)}&country=in&limit=${limit}`;

        if (options.biasCoords && options.biasCoords.lat && options.biasCoords.lon) {
          // Mapbox proximity parameter takes longitude,latitude
          url += `&proximity=${options.biasCoords.lon},${options.biasCoords.lat}`;
        }

        const headers = { 'Accept': 'application/json' };
        const res = await fetch(url, {
          signal: options.signal,
          headers: headers
        });

        if (!res.ok) {
          const status = res.status;
          let message = `Mapbox API returned HTTP ${status}`;
          try {
            const errBody = await res.json();
            if (errBody && errBody.message) message += `: ${errBody.message}`;
          } catch (_) {}
          const error = new Error(message);
          error.status = status;
          throw error;
        }

        const data = await res.json();
        if (!data || !Array.isArray(data.features)) return [];

        const results = [];
        for (const f of data.features) {
          const normalized = this.normalize(f);
          if (normalized) {
            results.push(normalized);
          }
        }
        return results;
      },

      /**
       * Normalizes a Mapbox Feature (v5 GeoJSON) into a standard NormalizedSearchResult
       */
      normalize(f) {
        if (!f || typeof f !== 'object') return null;

        // Mapbox coordinates: feature.geometry.coordinates is [lon, lat], or feature.center [lon, lat]
        const coords = (f.geometry && Array.isArray(f.geometry.coordinates))
          ? f.geometry.coordinates
          : (Array.isArray(f.center) ? f.center : null);

        if (!coords || coords.length < 2) return null;

        const coordCheck = validateCoordinates(coords[1], coords[0]);
        if (!coordCheck.valid) return null;

        // Extract hierarchical context from Mapbox context array
        // Context items look like: { id: "place.123", text: "Warangal" }, { id: "region.456", text: "Telangana" }
        const contextList = Array.isArray(f.context) ? f.context : [];
        let locality = '';
        let city = '';
        let district = '';
        let state = '';
        let country = 'India';
        let postcode = '';

        for (const c of contextList) {
          const id = (c.id || '').toLowerCase();
          const text = c.text || '';
          if (id.startsWith('neighborhood') || id.startsWith('locality')) {
            if (!locality) locality = text;
          } else if (id.startsWith('place')) {
            if (!city) city = text;
          } else if (id.startsWith('district')) {
            if (!district) district = text;
          } else if (id.startsWith('region')) {
            if (!state) state = text;
          } else if (id.startsWith('country')) {
            if (text) country = text;
          } else if (id.startsWith('postcode')) {
            if (!postcode) postcode = text;
          }
        }

        const placeTypes = Array.isArray(f.place_type) ? f.place_type : [];
        const primaryType = placeTypes[0] || (f.properties && f.properties.category) || 'place';
        const primaryName = f.text || (f.place_name ? f.place_name.split(',')[0].trim() : 'Location');

        // Build human-friendly context string
        const contextParts = [];
        if (locality && locality.toLowerCase() !== primaryName.toLowerCase()) contextParts.push(locality);
        if (city && city.toLowerCase() !== primaryName.toLowerCase() && city.toLowerCase() !== locality.toLowerCase()) contextParts.push(city);
        if (district && district.toLowerCase() !== primaryName.toLowerCase() && district.toLowerCase() !== city.toLowerCase()) contextParts.push(district);
        if (state && state.toLowerCase() !== primaryName.toLowerCase()) contextParts.push(state);

        let context = contextParts.join(', ');
        if (!context && f.place_name) {
          const parts = f.place_name.split(',');
          if (parts.length > 1) {
            context = parts.slice(1, 4).join(',').trim();
          }
        }

        const category = primaryType === 'poi' ? 'poi' : (primaryType === 'address' ? 'address' : 'place');

        return {
          provider: 'mapbox',
          primaryName: primaryName,
          displayName: f.place_name || primaryName,
          label: f.place_name || (primaryName + (context ? ', ' + context : '')),
          lat: coordCheck.lat,
          lon: coordCheck.lon,
          category: category,
          type: primaryType,
          icon: getCategoryIcon(category, primaryType),
          context: context,
          localityOrCity: locality || city || district || state,
          locality: locality,
          city: city,
          district: district,
          state: state,
          country: country,
          postcode: postcode,
          importance: typeof f.relevance === 'number' ? f.relevance : 0.8,
          raw: f
        };
      }
    };
  })();

  // ===================================================================
  // 5. NAVALERT PLACE SEARCH SERVICE
  // ===================================================================

  const NavalertSearchService = (function () {
    const providers = new Map();
    const queryCache = new Map();

    // Register default providers
    providers.set(MapboxSearchProvider.name, MapboxSearchProvider);
    providers.set(NominatimSearchProvider.name, NominatimSearchProvider);
    providers.set(PhotonSearchProvider.name, PhotonSearchProvider);

    function rankAndDeduplicate(candidates, query, biasCoords) {
      if (!Array.isArray(candidates) || candidates.length === 0) return [];
      const qLower = (query || '').toLowerCase();
      const processed = [];
      const seenGeoKeys = new Set();
      const seenNameLocality = new Set();

      for (const c of candidates) {
        if (!c) continue;
        const coordCheck = validateCoordinates(c.lat, c.lon);
        if (!coordCheck.valid) continue;

        // Spatial deduplication: ~100m grid cell (3 decimal places)
        const geoKey = coordCheck.lat.toFixed(3) + ',' + coordCheck.lon.toFixed(3);
        if (seenGeoKeys.has(geoKey)) continue;

        // Semantic deduplication: same primary name + locality
        const nameKey = (c.primaryName || '').trim().toLowerCase() + '::' + (c.localityOrCity || '').trim().toLowerCase();
        if (seenNameLocality.has(nameKey)) continue;

        seenGeoKeys.add(geoKey);
        seenNameLocality.add(nameKey);

        const cat = (c.category || '').toLowerCase();
        const type = (c.type || '').toLowerCase();
        const nLower = (c.primaryName || '').toLowerCase();

        let score = 50.0;
        if (typeof c.importance === 'number') {
          score += (c.importance * 35.0);
        }

        // Exact & prefix matching boost
        if (nLower === qLower) score += 35;
        else if (nLower.startsWith(qLower)) score += 20;
        else if (nLower.includes(qLower)) score += 10;

        // Category priority
        if (cat === 'railway' || type === 'station' || type === 'bus_station') score += 25;
        else if (cat === 'tourism' || cat === 'historic') score += 20;
        else if (cat === 'place' && ['city', 'town', 'suburb', 'village'].includes(type)) score += 20;
        else if (cat === 'amenity' && (type.includes('college') || type.includes('school') || type.includes('university') || type.includes('hospital'))) score += 15;
        else if (cat === 'amenity' && ['restaurant', 'fast_food', 'cafe', 'bar', 'fuel'].includes(type)) {
          if (!qLower.includes('food') && !qLower.includes('restaurant') && !qLower.includes('hotel') && !qLower.includes('cafe')) {
            score -= 30; // Deprioritize generic eatery matching landmark search
          }
        }

        // Proximity bonus based on detected/bias coordinates
        if (biasCoords && typeof biasCoords.lat === 'number' && typeof biasCoords.lon === 'number') {
          const biasCheck = validateCoordinates(biasCoords.lat, biasCoords.lon);
          if (biasCheck.valid) {
            const dist = computeDistanceKm(biasCheck.lat, biasCheck.lon, coordCheck.lat, coordCheck.lon);
            if (dist <= 25) score += 25;
            else if (dist <= 75) score += 15;
            else if (dist <= 200) score += 8;
          }
        }

        processed.push({
          primaryName: c.primaryName,
          displayName: c.displayName || c.primaryName,
          label: c.label || c.displayName || c.primaryName,
          lat: coordCheck.lat,
          lon: coordCheck.lon,
          category: cat,
          type: type,
          icon: c.icon || getCategoryIcon(cat, type),
          context: c.context || '',
          localityOrCity: c.localityOrCity || '',
          locality: c.locality || '',
          city: c.city || '',
          district: c.district || '',
          state: c.state || '',
          country: c.country || '',
          postcode: c.postcode || '',
          provider: c.provider,
          importance: c.importance,
          score: score,
          raw: c.raw
        });
      }

      processed.sort((a, b) => b.score - a.score);
      return processed.slice(0, 5); // Return top 3-5 results
    }

    async function search(query, options) {
      options = options || {};
      const q = normalizeQuery(query);
      if (!q || q.length < 2) return [];

      const cacheKey = q.toLowerCase() + (options.biasCoords ? '_' + options.biasCoords.lat.toFixed(2) + ',' + options.biasCoords.lon.toFixed(2) : '');
      if (queryCache.has(cacheKey) && !options.skipCache) {
        return queryCache.get(cacheKey);
      }

      // Default provider search chain: Mapbox -> Nominatim -> Photon
      const providerOrder = options.providers || ['mapbox', 'nominatim', 'photon'];
      let collectedCandidates = [];

      for (let i = 0; i < providerOrder.length; i++) {
        const pName = providerOrder[i];
        const provider = providers.get(pName);
        if (!provider) continue;

        // Skip provider if unconfigured (e.g. Mapbox without access token)
        if (typeof provider.isConfigured === 'function' && !provider.isConfigured()) {
          // Gracefully skip unconfigured provider without error
          continue;
        }

        try {
          const results = await provider.search(q, options);
          if (Array.isArray(results) && results.length > 0) {
            collectedCandidates = collectedCandidates.concat(results);
            if (collectedCandidates.length >= 3 && !options.queryAllProviders) {
              break; // Primary configured provider returned sufficient results
            }
          }
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          // Log warning and fall back smoothly to next provider in chain
          console.warn(`Search provider "${pName}" failed, falling back to next provider:`, err.message);
        }
      }

      const ranked = rankAndDeduplicate(collectedCandidates, q, options.biasCoords);
      if (ranked.length > 0) {
        queryCache.set(cacheKey, ranked);
      }
      return ranked;
    }

    return {
      registerProvider(provider) {
        if (provider && provider.name) {
          providers.set(provider.name, provider);
        }
      },
      getProvider(name) {
        return providers.get(name) || null;
      },
      getRegisteredProviders() {
        return Array.from(providers.keys());
      },
      getActiveProviders() {
        const active = [];
        for (const [name, p] of providers.entries()) {
          if (typeof p.isConfigured === 'function' ? p.isConfigured() : true) {
            active.push(name);
          }
        }
        return active;
      },
      clearCache() {
        queryCache.clear();
      },
      validateCoordinates,
      formatAddressContext,
      rankAndDeduplicate,
      search
    };
  })();

  return {
    validateCoordinates,
    computeDistanceKm,
    normalizeQuery,
    getCategoryIcon,
    formatAddressContext,
    NominatimSearchProvider,
    PhotonSearchProvider,
    MapboxSearchProvider,
    NavalertSearchService
  };
});
