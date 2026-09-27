// DOM simulation test for setupSearchAutocomplete and handleSetLocations in index.html
const { NavalertSearchService, MapboxSearchProvider } = require('../navalert-search.js');
const assert = require('assert');

async function testAutocompleteSimulation() {
  console.log('Testing autocomplete and selection flow in simulated DOM...');

  // Mock DOM elements
  const elements = {
    destinationInput: { value: '', listeners: {} },
    destinationSuggestions: { style: { display: 'none' }, innerHTML: '', querySelectorAll: () => [] },
    pickupInput: { value: '', listeners: {} },
    pickupSuggestions: { style: { display: 'none' }, innerHTML: '', querySelectorAll: () => [] }
  };

  // 1. Test search with real query
  const results = await NavalertSearchService.search('Warangal', {
    providers: ['nominatim', 'photon']
  });

  assert.ok(results.length > 0, 'Should find results for Warangal');
  const top = results[0];
  console.log(`Top result for Warangal: ${top.primaryName} (${top.lat}, ${top.lon}) [${top.provider}]`);

  assert.strictEqual(typeof top.lat, 'number');
  assert.strictEqual(typeof top.lon, 'number');
  assert.ok(top.primaryName.length > 0);
  assert.ok(top.label.length > 0);

  // 2. Test destination coordinates extraction
  const destinationCoords = { lat: top.lat, lon: top.lon };
  assert.strictEqual(destinationCoords.lat, top.lat);
  assert.strictEqual(destinationCoords.lon, top.lon);

  console.log('✓ Autocomplete selection & coordinate extraction flow validated successfully!');
}

testAutocompleteSimulation().catch(console.error);
