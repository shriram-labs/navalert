/**
 * NAVALERT PLACE SEARCH SERVICE TEST SUITE
 * 
 * Verifies:
 *   1. Coordinate validation (WGS84 boundaries, invalid types, NaN)
 *   2. Normalized result mapping (Mapbox v5, Nominatim, Photon)
 *   3. Empty search results handling
 *   4. Malformed provider response handling
 *   5. Duplicate results & spatial deduplication (~100m grid)
 *   6. Provider failure & fallback behavior (unconfigured, 401, network error)
 *   7. Mapbox provider configuration isolation
 *   8. Ranking & proximity bias
 */

const assert = require('assert');
const {
  validateCoordinates,
  computeDistanceKm,
  normalizeQuery,
  getCategoryIcon,
  formatAddressContext,
  NominatimSearchProvider,
  PhotonSearchProvider,
  MapboxSearchProvider,
  NavalertSearchService
} = require('../navalert-search.js');

let passedTests = 0;
let totalTests = 0;

async function runTest(description, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${description}`);
    console.error(`    Error: ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    process.exitCode = 1;
  }
}

async function main() {
  console.log('=== NAVALERT PLACE SEARCH TEST SUITE ===\n');

  // ---------------------------------------------------------------------
  // TEST GROUP 1: Coordinate Validation
  // ---------------------------------------------------------------------
  console.log('1. Coordinate Validation:');

  await runTest('Valid coordinates (Warangal, Telangana)', () => {
    const res = validateCoordinates(17.98206, 79.59710);
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.lat, 17.98206);
    assert.strictEqual(res.lon, 79.59710);
  });

  await runTest('Valid string coordinates parsed to float', () => {
    const res = validateCoordinates("17.44362", "78.35196");
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.lat, 17.44362);
    assert.strictEqual(res.lon, 78.35196);
  });

  await runTest('Boundary latitude values [-90, +90]', () => {
    assert.strictEqual(validateCoordinates(90, 0).valid, true);
    assert.strictEqual(validateCoordinates(-90, 0).valid, true);
    assert.strictEqual(validateCoordinates(90.0001, 0).valid, false);
    assert.strictEqual(validateCoordinates(-90.0001, 0).valid, false);
  });

  await runTest('Boundary longitude values [-180, +180]', () => {
    assert.strictEqual(validateCoordinates(0, 180).valid, true);
    assert.strictEqual(validateCoordinates(0, -180).valid, true);
    assert.strictEqual(validateCoordinates(0, 180.0001).valid, false);
    assert.strictEqual(validateCoordinates(0, -180.0001).valid, false);
  });

  await runTest('Rejects NaN, null, undefined, and non-numeric inputs', () => {
    assert.strictEqual(validateCoordinates(NaN, 78.5).valid, false);
    assert.strictEqual(validateCoordinates(17.5, NaN).valid, false);
    assert.strictEqual(validateCoordinates(null, 78.5).valid, false);
    assert.strictEqual(validateCoordinates(17.5, undefined).valid, false);
    assert.strictEqual(validateCoordinates('invalid-lat', 78.5).valid, false);
    assert.strictEqual(validateCoordinates(Infinity, 0).valid, false);
  });

  // ---------------------------------------------------------------------
  // TEST GROUP 2: Normalized Result Mapping
  // ---------------------------------------------------------------------
  console.log('\n2. Normalized Result Mapping:');

  await runTest('Mapbox v5 GeoJSON feature normalized correctly', () => {
    const mapboxFeature = {
      id: "place.12345",
      type: "Feature",
      place_type: ["place"],
      relevance: 0.95,
      text: "Warangal",
      place_name: "Warangal, Telangana, India",
      center: [79.59710, 17.98206],
      geometry: {
        type: "Point",
        coordinates: [79.59710, 17.98206]
      },
      context: [
        { id: "district.101", text: "Warangal" },
        { id: "region.202", text: "Telangana" },
        { id: "country.303", text: "India" },
        { id: "postcode.404", text: "506002" }
      ]
    };

    const norm = MapboxSearchProvider.normalize(mapboxFeature);
    assert.ok(norm, 'Normalized object should exist');
    assert.strictEqual(norm.provider, 'mapbox');
    assert.strictEqual(norm.primaryName, 'Warangal');
    assert.strictEqual(norm.displayName, 'Warangal, Telangana, India');
    assert.strictEqual(norm.lat, 17.98206);
    assert.strictEqual(norm.lon, 79.59710);
    assert.strictEqual(norm.type, 'place');
    assert.strictEqual(norm.state, 'Telangana');
    assert.strictEqual(norm.country, 'India');
    assert.strictEqual(norm.postcode, '506002');
    assert.strictEqual(norm.importance, 0.95);
  });

  await runTest('Nominatim jsonv2 item normalized correctly', () => {
    const nomItem = {
      place_id: 248864385,
      lat: "17.97330",
      lon: "79.60561",
      category: "railway",
      type: "station",
      name: "Warangal",
      display_name: "Warangal, Shivanagar Road, Warangal, Telangana, 506002, India",
      importance: 0.72,
      address: {
        railway: "Warangal",
        road: "Shivanagar Road",
        city: "Warangal",
        state_district: "Warangal",
        state: "Telangana",
        postcode: "506002",
        country: "India"
      }
    };

    const norm = NominatimSearchProvider.normalize(nomItem);
    assert.ok(norm);
    assert.strictEqual(norm.provider, 'nominatim');
    assert.strictEqual(norm.primaryName, 'Warangal');
    assert.strictEqual(norm.lat, 17.97330);
    assert.strictEqual(norm.lon, 79.60561);
    assert.strictEqual(norm.category, 'railway');
    assert.strictEqual(norm.type, 'station');
    assert.strictEqual(norm.icon, '🚉');
    assert.strictEqual(norm.city, 'Warangal');
    assert.strictEqual(norm.state, 'Telangana');
    assert.strictEqual(norm.postcode, '506002');
  });

  await runTest('Photon GeoJSON feature normalized correctly', () => {
    const photonFeature = {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [78.35196, 17.44362]
      },
      properties: {
        osm_id: 123456,
        osm_key: "place",
        osm_value: "suburb",
        name: "Gachibowli",
        city: "Hyderabad",
        state: "Telangana",
        country: "India",
        postcode: "500032"
      }
    };

    const norm = PhotonSearchProvider.normalize(photonFeature);
    assert.ok(norm);
    assert.strictEqual(norm.provider, 'photon');
    assert.strictEqual(norm.primaryName, 'Gachibowli');
    assert.strictEqual(norm.lat, 17.44362);
    assert.strictEqual(norm.lon, 78.35196);
    assert.strictEqual(norm.category, 'place');
    assert.strictEqual(norm.type, 'suburb');
    assert.strictEqual(norm.city, 'Hyderabad');
    assert.strictEqual(norm.state, 'Telangana');
  });

  // ---------------------------------------------------------------------
  // TEST GROUP 3: Empty Search Results Handling
  // ---------------------------------------------------------------------
  console.log('\n3. Empty Results Handling:');

  await runTest('Empty string, whitespace, and 1-character queries return empty array', async () => {
    assert.deepStrictEqual(await NavalertSearchService.search(''), []);
    assert.deepStrictEqual(await NavalertSearchService.search('   '), []);
    assert.deepStrictEqual(await NavalertSearchService.search('a'), []);
  });

  await runTest('rankAndDeduplicate handles empty or null candidate lists gracefully', () => {
    assert.deepStrictEqual(NavalertSearchService.rankAndDeduplicate([], 'Warangal'), []);
    assert.deepStrictEqual(NavalertSearchService.rankAndDeduplicate(null, 'Warangal'), []);
    assert.deepStrictEqual(NavalertSearchService.rankAndDeduplicate(undefined, 'Warangal'), []);
  });

  // ---------------------------------------------------------------------
  // TEST GROUP 4: Malformed Provider Response Handling
  // ---------------------------------------------------------------------
  console.log('\n4. Malformed Provider Response Handling:');

  await runTest('Normalizers return null for null, undefined, or empty objects', () => {
    assert.strictEqual(MapboxSearchProvider.normalize(null), null);
    assert.strictEqual(MapboxSearchProvider.normalize(undefined), null);
    assert.strictEqual(MapboxSearchProvider.normalize({}), null);
    assert.strictEqual(NominatimSearchProvider.normalize(null), null);
    assert.strictEqual(PhotonSearchProvider.normalize(null), null);
  });

  await runTest('Normalizers reject features with invalid coordinates', () => {
    const badCoords = {
      text: "Bad Loc",
      geometry: { coordinates: ["invalid", 17.5] }
    };
    assert.strictEqual(MapboxSearchProvider.normalize(badCoords), null);

    const outOfBounds = {
      text: "OutOfBounds",
      geometry: { coordinates: [79.5, 999.0] }
    };
    assert.strictEqual(MapboxSearchProvider.normalize(outOfBounds), null);
  });

  await runTest('Provider returning malformed data does not crash SearchService', async () => {
    const brokenProvider = {
      name: 'broken',
      isConfigured: () => true,
      search: async () => 'not-an-array'
    };

    NavalertSearchService.registerProvider(brokenProvider);
    const results = await NavalertSearchService.search('Test Query', {
      providers: ['broken'],
      skipCache: true
    });

    assert.deepStrictEqual(results, [], 'Should return empty array without crashing');
  });

  // ---------------------------------------------------------------------
  // TEST GROUP 5: Duplicate Results & Spatial Deduplication
  // ---------------------------------------------------------------------
  console.log('\n5. Duplicate Results & Spatial Deduplication:');

  await runTest('Spatially close results (~100m) are deduplicated', () => {
    const candidates = [
      {
        primaryName: "Warangal Bus Station",
        displayName: "Warangal Bus Station, Telangana",
        lat: 17.98201,
        lon: 79.59711,
        category: "amenity",
        type: "bus_station",
        importance: 0.6
      },
      {
        // Coordinate differs by less than ~100m (same 3 decimal places 17.982, 79.597)
        primaryName: "Warangal Bus Stop",
        displayName: "Warangal Bus Stop, Telangana",
        lat: 17.98208,
        lon: 79.59714,
        category: "amenity",
        type: "bus_station",
        importance: 0.5
      }
    ];

    const deduplicated = NavalertSearchService.rankAndDeduplicate(candidates, 'Warangal');
    assert.strictEqual(deduplicated.length, 1, 'Should deduplicate spatially redundant candidates to 1');
    assert.strictEqual(deduplicated[0].primaryName, 'Warangal Bus Station');
  });

  await runTest('Semantically identical results with same primary name and locality are deduplicated', () => {
    const candidates = [
      {
        primaryName: "Hanamkonda",
        localityOrCity: "Warangal",
        lat: 18.0068,
        lon: 79.5578,
        importance: 0.7
      },
      {
        primaryName: "Hanamkonda",
        localityOrCity: "Warangal",
        lat: 18.0090, // slightly different coordinates outside 100m
        lon: 79.5600,
        importance: 0.5
      }
    ];

    const deduplicated = NavalertSearchService.rankAndDeduplicate(candidates, 'Hanamkonda');
    assert.strictEqual(deduplicated.length, 1, 'Should deduplicate identical name & locality');
  });

  await runTest('Distinct places are preserved', () => {
    const candidates = [
      { primaryName: "Warangal", lat: 17.9820, lon: 79.5971, importance: 0.8 },
      { primaryName: "Hanamkonda", lat: 18.0068, lon: 79.5578, importance: 0.7 },
      { primaryName: "Kazipet", lat: 17.9807, lon: 79.5131, importance: 0.7 }
    ];

    const deduplicated = NavalertSearchService.rankAndDeduplicate(candidates, 'Warangal');
    assert.strictEqual(deduplicated.length, 3, 'Should preserve 3 distinct locations');
  });

  // ---------------------------------------------------------------------
  // TEST GROUP 6: Provider Failure & Fallback Behavior
  // ---------------------------------------------------------------------
  console.log('\n6. Provider Failure & Fallback Behavior:');

  await runTest('MapboxSearchProvider correctly identifies unconfigured state without fake tokens', () => {
    MapboxSearchProvider.setAccessToken('');
    assert.strictEqual(MapboxSearchProvider.isConfigured(), false);

    MapboxSearchProvider.setAccessToken('PASTE_YOUR_KEY_HERE');
    assert.strictEqual(MapboxSearchProvider.isConfigured(), false);

    MapboxSearchProvider.setAccessToken('short');
    assert.strictEqual(MapboxSearchProvider.isConfigured(), false);
  });

  await runTest('MapboxSearchProvider recognizes valid token structure format', () => {
    MapboxSearchProvider.setAccessToken('pk.eyJ1IjoiZXhhbXBsZXVzZXIiLCJhIjoiY2xleGFtcGxlMDAwMDAwMHpvb2JhciJ9.exampleSignature');
    assert.strictEqual(MapboxSearchProvider.isConfigured(), true);
    // Reset token after test
    MapboxSearchProvider.setAccessToken('');
  });

  await runTest('Unconfigured Mapbox provider is skipped gracefully without breaking search', async () => {
    MapboxSearchProvider.setAccessToken(''); // Unconfigured

    const mockFallbackProvider = {
      name: 'mock_fallback',
      isConfigured: () => true,
      search: async () => [
        {
          provider: 'mock_fallback',
          primaryName: 'Kazipet Junction',
          lat: 17.9807,
          lon: 79.5131,
          category: 'railway',
          type: 'station',
          importance: 0.9
        }
      ]
    };

    NavalertSearchService.registerProvider(mockFallbackProvider);

    const results = await NavalertSearchService.search('Kazipet', {
      providers: ['mapbox', 'mock_fallback'],
      skipCache: true
    });

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].primaryName, 'Kazipet Junction');
    assert.strictEqual(results[0].provider, 'mock_fallback');
  });

  await runTest('Provider throwing 401 Unauthorized falls back smoothly to next provider', async () => {
    const failingProvider = {
      name: 'failing_provider',
      isConfigured: () => true,
      search: async () => {
        const err = new Error('HTTP 401: Not Authorized - Invalid Token');
        err.status = 401;
        throw err;
      }
    };

    const backupProvider = {
      name: 'backup_provider',
      isConfigured: () => true,
      search: async () => [
        {
          provider: 'backup_provider',
          primaryName: 'Warangal Fort',
          lat: 17.9587,
          lon: 79.6163,
          category: 'historic',
          type: 'fort',
          importance: 0.85
        }
      ]
    };

    NavalertSearchService.registerProvider(failingProvider);
    NavalertSearchService.registerProvider(backupProvider);

    const results = await NavalertSearchService.search('Warangal Fort', {
      providers: ['failing_provider', 'backup_provider'],
      skipCache: true
    });

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].primaryName, 'Warangal Fort');
    assert.strictEqual(results[0].provider, 'backup_provider');
  });

  // ---------------------------------------------------------------------
  // TEST GROUP 7: Ranking & Proximity Bias
  // ---------------------------------------------------------------------
  console.log('\n7. Ranking & Proximity Bias:');

  await runTest('Exact match and transport categories are prioritized in scoring', () => {
    const candidates = [
      {
        primaryName: "Warangal Cafe",
        category: "amenity",
        type: "cafe",
        lat: 17.985,
        lon: 79.595,
        importance: 0.2
      },
      {
        primaryName: "Warangal Railway Station",
        category: "railway",
        type: "station",
        lat: 17.973,
        lon: 79.605,
        importance: 0.8
      },
      {
        primaryName: "Warangal",
        category: "place",
        type: "city",
        lat: 17.982,
        lon: 79.597,
        importance: 0.9
      }
    ];

    const rankedForCity = NavalertSearchService.rankAndDeduplicate(candidates, 'Warangal');
    assert.strictEqual(rankedForCity[0].primaryName, 'Warangal', 'Exact city match should rank first');

    const rankedForStation = NavalertSearchService.rankAndDeduplicate(candidates, 'Warangal Railway Station');
    assert.strictEqual(rankedForStation[0].primaryName, 'Warangal Railway Station', 'Station match should rank first');
  });

  await runTest('Proximity bias boosts closer results for ambiguous place names', () => {
    const candidates = [
      {
        primaryName: "Ramnagar",
        localityOrCity: "Nainital, Uttarakhand",
        lat: 29.3948,
        lon: 79.1269,
        importance: 0.7
      },
      {
        primaryName: "Ramnagar",
        localityOrCity: "Narsampet, Telangana",
        lat: 18.0156,
        lon: 79.8636,
        importance: 0.4
      }
    ];

    // Bias near Warangal (17.98, 79.59)
    const biasCoords = { lat: 17.9784, lon: 79.5941 };
    const ranked = NavalertSearchService.rankAndDeduplicate(candidates, 'Ramnagar', biasCoords);

    assert.strictEqual(ranked[0].localityOrCity, 'Narsampet, Telangana', 'Telangana locality should be boosted by proximity bias');
  });

  console.log(`\n=== TEST RESULTS: ${passedTests}/${totalTests} tests passed ===\n`);
  if (passedTests === totalTests) {
    console.log('ALL TESTS PASSED SUCCESSFULLY! ✓\n');
  } else {
    console.error(`FAILED: ${totalTests - passedTests} tests failed.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error in test suite:', err);
  process.exit(1);
});
