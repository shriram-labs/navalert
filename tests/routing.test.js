/**
 * NAVALERT ROUTING SERVICE & MAPBOX PROVIDER TEST SUITE
 * 
 * Verifies:
 *   1. Mapbox response normalization
 *   2. Distance conversion (meters -> km)
 *   3. Duration conversion (seconds -> minutes)
 *   4. Geometry extraction (GeoJSON LineString -> WGS84 waypoints)
 *   5. Malformed response handling
 *   6. Empty routes handling
 *   7. Provider failure handling
 *   8. Token-not-configured behavior
 *   9. NAVALERT geometry diversity algorithm on Mapbox routes
 *  10. OSRM provider backwards compatibility
 */

const assert = require('assert');
const {
  haversineMeters,
  computeGeometryOverlap,
  computeRouteViaLabels,
  filterAndRankRoutes,
  OsrmRoutingProvider,
  MapboxRoutingProvider,
  NavalertRoutingService
} = require('../navalert-routing.js');

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

// Sample Mapbox Directions v5 response fixture (Hyderabad -> Warangal)
const sampleMapboxRoute = {
  distance: 150345.6,
  duration: 7620.0,
  weight_name: 'routability',
  weight: 7850.2,
  geometry: {
    type: 'LineString',
    coordinates: [
      [78.47406, 17.36059],
      [78.48512, 17.37120],
      [78.52040, 17.41010],
      [79.10050, 17.75000],
      [79.59710, 17.98206]
    ]
  },
  legs: [
    {
      distance: 150345.6,
      duration: 7620.0,
      summary: 'NH 163',
      steps: [
        { name: 'Inner Ring Road', distance: 5400, duration: 420 },
        { name: 'NH 163', distance: 140000, duration: 6800 },
        { name: 'Station Road', distance: 4945.6, duration: 400 }
      ]
    }
  ]
};

async function main() {
  console.log('=== NAVALERT ROUTING & MAPBOX PROVIDER TEST SUITE ===\n');

  // ---------------------------------------------------------------------
  // TEST GROUP 1: Mapbox Response Normalization
  // ---------------------------------------------------------------------
  console.log('1. Mapbox Response Normalization:');

  await runTest('Normalizes Mapbox route fixture to standard NAVALERT representation', () => {
    const norm = MapboxRoutingProvider.normalize(sampleMapboxRoute, 0, 7620.0, 150345.6);
    assert.ok(norm, 'Normalized object should exist');
    assert.strictEqual(norm.id, 'mapbox-0');
    assert.strictEqual(norm.provider, 'mapbox');
    assert.strictEqual(norm.index, 0);
    assert.strictEqual(norm.distanceMeters, 150345.6);
    assert.strictEqual(norm.durationSeconds, 7620.0);
    assert.strictEqual(norm.distanceKm, '150.3');
    assert.strictEqual(norm.durationMin, 127);
    assert.strictEqual(norm.isFastest, true);
    assert.strictEqual(norm.diffMin, 0);
    assert.strictEqual(norm.diffKm, '0.0');
    assert.strictEqual(norm.summary, 'NH 163');
    assert.ok(Array.isArray(norm.legs));
    assert.strictEqual(norm.raw, sampleMapboxRoute);
  });

  // ---------------------------------------------------------------------
  // TEST GROUP 2: Distance & Duration Conversion
  // ---------------------------------------------------------------------
  console.log('\n2. Distance & Duration Conversion:');

  await runTest('Distance in meters correctly converted to 1-decimal km', () => {
    const norm = MapboxRoutingProvider.normalize(
      { ...sampleMapboxRoute, distance: 21500.0, duration: 1800.0 },
      1,
      1740.0,
      20000.0
    );
    assert.strictEqual(norm.distanceKm, '21.5');
    assert.strictEqual(norm.diffKm, '1.5');
  });

  await runTest('Duration in seconds correctly converted to rounded minutes', () => {
    const norm = MapboxRoutingProvider.normalize(
      { ...sampleMapboxRoute, distance: 21450.0, duration: 1845.0 },
      1,
      1740.0,
      20000.0
    );
    assert.strictEqual(norm.durationMin, 31); // 1845s / 60 = 30.75 -> 31 min
    assert.strictEqual(norm.diffMin, 2);     // (1845 - 1740) / 60 = 1.75 -> 2 min
    assert.strictEqual(norm.isFastest, false);
  });

  // ---------------------------------------------------------------------
  // TEST GROUP 3: Geometry & Waypoint Extraction
  // ---------------------------------------------------------------------
  console.log('\n3. Geometry & Waypoint Extraction:');

  await runTest('GeoJSON coordinates [lon, lat] mapped to GPS waypoints {lat, lon}', () => {
    const norm = MapboxRoutingProvider.normalize(sampleMapboxRoute, 0, 7620.0, 150345.6);
    assert.strictEqual(norm.coordinates.length, 5);
    assert.strictEqual(norm.waypoints.length, 5);

    // Verify coordinate order inversion: GeoJSON [lon, lat] -> NAVALERT { lat, lon }
    assert.strictEqual(norm.coordinates[0][0], 78.47406); // lon
    assert.strictEqual(norm.coordinates[0][1], 17.36059); // lat

    assert.strictEqual(norm.waypoints[0].lat, 17.36059);
    assert.strictEqual(norm.waypoints[0].lon, 78.47406);
    assert.strictEqual(norm.waypoints[4].lat, 17.98206);
    assert.strictEqual(norm.waypoints[4].lon, 79.59710);
  });

  // ---------------------------------------------------------------------
  // TEST GROUP 4: Malformed Response Handling
  // ---------------------------------------------------------------------
  console.log('\n4. Malformed Response Handling:');

  await runTest('Normalizer returns null for null, undefined, or missing geometry', () => {
    assert.strictEqual(MapboxRoutingProvider.normalize(null, 0, 0, 0), null);
    assert.strictEqual(MapboxRoutingProvider.normalize(undefined, 0, 0, 0), null);
    assert.strictEqual(MapboxRoutingProvider.normalize({}, 0, 0, 0), null);
    assert.strictEqual(MapboxRoutingProvider.normalize({ geometry: null }, 0, 0, 0), null);
    assert.strictEqual(MapboxRoutingProvider.normalize({ geometry: { coordinates: 'not-array' } }, 0, 0, 0), null);
  });

  await runTest('filterAndRankRoutes handles empty or null array without error', () => {
    assert.deepStrictEqual(filterAndRankRoutes([]), []);
    assert.deepStrictEqual(filterAndRankRoutes(null), []);
    assert.deepStrictEqual(filterAndRankRoutes(undefined), []);
  });

  // ---------------------------------------------------------------------
  // TEST GROUP 5: Empty Routes Handling
  // ---------------------------------------------------------------------
  console.log('\n5. Empty Routes Handling:');

  await runTest('Empty routes array returns { routes: [], primaryRoute: null }', async () => {
    const mockEmptyProvider = {
      name: 'mock_empty',
      isConfigured: () => true,
      calculateRoute: async () => []
    };
    NavalertRoutingService.registerProvider(mockEmptyProvider);

    const result = await NavalertRoutingService.calculateRoute(
      { lat: 17.36, lon: 78.47 },
      { lat: 17.98, lon: 79.59 },
      { provider: 'mock_empty' }
    );

    assert.strictEqual(result.provider, 'mock_empty');
    assert.deepStrictEqual(result.routes, []);
    assert.strictEqual(result.primaryRoute, null);
  });

  // ---------------------------------------------------------------------
  // TEST GROUP 6: Provider Failure Handling
  // ---------------------------------------------------------------------
  console.log('\n6. Provider Failure Handling:');

  await runTest('Propagates provider runtime errors with diagnostic context', async () => {
    const failingProvider = {
      name: 'mock_failing',
      isConfigured: () => true,
      calculateRoute: async () => {
        throw new Error('HTTP 429: Rate limit exceeded');
      }
    };
    NavalertRoutingService.registerProvider(failingProvider);

    await assert.rejects(
      async () => {
        await NavalertRoutingService.calculateRoute(
          { lat: 17.36, lon: 78.47 },
          { lat: 17.98, lon: 79.59 },
          { provider: 'mock_failing' }
        );
      },
      /Rate limit exceeded/
    );
  });

  // ---------------------------------------------------------------------
  // TEST GROUP 7: Token-Not-Configured Behavior
  // ---------------------------------------------------------------------
  console.log('\n7. Token-Not-Configured Behavior:');

  await runTest('MapboxRoutingProvider detects unconfigured token state', () => {
    MapboxRoutingProvider.setAccessToken('');
    assert.strictEqual(MapboxRoutingProvider.isConfigured(), false);

    MapboxRoutingProvider.setAccessToken('PASTE_YOUR_KEY_HERE');
    assert.strictEqual(MapboxRoutingProvider.isConfigured(), false);

    MapboxRoutingProvider.setAccessToken('short');
    assert.strictEqual(MapboxRoutingProvider.isConfigured(), false);
  });

  await runTest('MapboxRoutingProvider throws descriptive error when unconfigured', async () => {
    MapboxRoutingProvider.setAccessToken(''); // Clear token
    assert.strictEqual(MapboxRoutingProvider.isConfigured(), false);

    await assert.rejects(
      async () => {
        await NavalertRoutingService.calculateRoute(
          { lat: 17.36, lon: 78.47 },
          { lat: 17.98, lon: 79.59 },
          { provider: 'mapbox' }
        );
      },
      /Routing provider 'mapbox' is not configured/
    );
  });

  await runTest('MapboxRoutingProvider accepts valid token structure', () => {
    MapboxRoutingProvider.setAccessToken('pk.eyJ1IjoidGVzdHVzZXIiLCJhIjoiY2xleGFtcGxlMDAwMDAwMHpvb2JhciJ9.exampleSignature');
    assert.strictEqual(MapboxRoutingProvider.isConfigured(), true);
    // Reset after test
    MapboxRoutingProvider.setAccessToken('');
  });

  // ---------------------------------------------------------------------
  // TEST GROUP 8: NAVALERT Geometry Diversity Compatibility
  // ---------------------------------------------------------------------
  console.log('\n8. NAVALERT Geometry Diversity Compatibility:');

  await runTest('Genuine alternative route correctly classified as GENUINE_ALTERNATIVE', () => {
    // Primary route
    const routeA = {
      distance: 92900,
      duration: 4020,
      geometry: {
        type: 'LineString',
        coordinates: [
          [79.5971, 17.9820],
          [79.7000, 17.9000],
          [79.8000, 17.8000],
          [80.0038, 17.5985]
        ]
      },
      legs: [{ steps: [{ name: 'Mandi Bazar Rd' }, { name: 'NH 365' }] }]
    };

    // Substantially distinct regional alternative (separated by 15+ km)
    const routeB = {
      distance: 83500,
      duration: 4440,
      geometry: {
        type: 'LineString',
        coordinates: [
          [79.5971, 17.9820],
          [79.5000, 17.8500],
          [79.6000, 17.7000],
          [80.0038, 17.5985]
        ]
      },
      legs: [{ steps: [{ name: 'Jayaprakash Narayan Road' }, { name: 'SH 24' }] }]
    };

    const ranked = filterAndRankRoutes([routeA, routeB], { provider: 'mapbox' });
    assert.strictEqual(ranked.length, 2);
    assert.strictEqual(ranked[0].diversityVerdict, 'PRIMARY');
    assert.strictEqual(ranked[1].diversityVerdict, 'GENUINE_ALTERNATIVE');
    assert.strictEqual(ranked[1].isGenuineAlternative, true);
    assert.ok(ranked[1].maxSeparationMeters >= 400.0);
    assert.ok(ranked[1].overlapWithPrimary < 75.0);
  });

  await runTest('Minor parallel deviation correctly classified as PSEUDO_DUPLICATE', () => {
    const routeA = {
      distance: 40200,
      duration: 2760,
      geometry: {
        type: 'LineString',
        coordinates: [
          [77.0895, 28.4949],
          [77.1500, 28.5300],
          [77.2500, 28.5800],
          [77.3649, 28.6280]
        ]
      },
      legs: [{ steps: [{ name: 'Delhi Ring Road' }] }]
    };

    // Parallel route with 90% overlap and minimal separation (< 150m)
    const routeB = {
      distance: 40100,
      duration: 2790,
      geometry: {
        type: 'LineString',
        coordinates: [
          [77.0895, 28.4949],
          [77.1505, 28.5305], // parallel slip road ~50m apart
          [77.2505, 28.5805],
          [77.3649, 28.6280]
        ]
      },
      legs: [{ steps: [{ name: 'Delhi Ring Road Service Lane' }] }]
    };

    const ranked = filterAndRankRoutes([routeA, routeB], { provider: 'mapbox' });
    assert.strictEqual(ranked.length, 2);
    assert.strictEqual(ranked[1].diversityVerdict, 'PSEUDO_DUPLICATE');
    assert.strictEqual(ranked[1].isGenuineAlternative, false);

    // With filterDuplicates: true, pseudo-duplicate should be pruned
    const filtered = filterAndRankRoutes([routeA, routeB], {
      provider: 'mapbox',
      filterDuplicates: true
    });
    assert.strictEqual(filtered.length, 1, 'Should filter out pseudo duplicate');
    assert.strictEqual(filtered[0].diversityVerdict, 'PRIMARY');
  });

  // ---------------------------------------------------------------------
  // TEST GROUP 9: OSRM Backwards Compatibility
  // ---------------------------------------------------------------------
  console.log('\n9. OSRM Backwards Compatibility:');

  await runTest('OSRM provider remains default and configured', () => {
    const osrm = NavalertRoutingService.getProvider('osrm');
    assert.ok(osrm, 'OSRM provider must be registered');
    assert.strictEqual(osrm.name, 'osrm');
    assert.strictEqual(osrm.isConfigured(), true);
  });

  await runTest('Active providers list correctly reflects configuration', () => {
    MapboxRoutingProvider.setAccessToken('');
    const activeWithoutToken = NavalertRoutingService.getActiveProviders();
    assert.strictEqual(activeWithoutToken.includes('osrm'), true);
    assert.strictEqual(activeWithoutToken.includes('mapbox'), false);

    MapboxRoutingProvider.setAccessToken('pk.eyJ1IjoidGVzdHVzZXIiLCJhIjoiY2xleGFtcGxlMDAwMDAwMHpvb2JhciJ9.exampleSignature');
    const activeWithToken = NavalertRoutingService.getActiveProviders();
    assert.strictEqual(activeWithToken.includes('osrm'), true);
    assert.strictEqual(activeWithToken.includes('mapbox'), true);

    MapboxRoutingProvider.setAccessToken('');
  });

  console.log(`\n=== TEST RESULTS: ${passedTests}/${totalTests} tests passed ===\n`);
  if (passedTests === totalTests) {
    console.log('ALL ROUTING TESTS PASSED SUCCESSFULLY! ✓\n');
  } else {
    console.error(`FAILED: ${totalTests - passedTests} tests failed.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error in routing test suite:', err);
  process.exit(1);
});
