/**
 * @license
 * Copyright 2019 Google LLC
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// ################################################################
// ### FUNCTIONS ###
// ################################################################

// Define coefficients supplied by Roy et. al. 2016 for translating ETM+
// surface reflectance to OLI surface reflectance.
var coefficients = {
  itcps: ee.Image.constant([0.0003, 0.0088, 0.0061, 0.0412, 0.0254, 0.0172]).multiply(10000),
  slopes: ee.Image.constant([0.8474, 0.8483, 0.9047, 0.8462, 0.8937, 0.9071])
};

// Define function to get consistent band names (OLI).
function oliBands(img) {
  return ee.Image(ee.Algorithms.If(
    ee.Algorithms.IsEqual(img.get('SATELLITE'), ee.String('LANDSAT_8')),
    img.select(['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'pixel_qa']),
    img.select(['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'pixel_qa'], ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'pixel_qa'])
  ));
}

// Define function to apply harmonization transformation.
function etm2oli(img) {
  return img.select(['B2', 'B3', 'B4', 'B5', 'B6', 'B7'])
    .multiply(coefficients.slopes)
    .add(coefficients.itcps)
    .round()
    .toShort()
    .addBands(img.select('pixel_qa')
  );
}

// Define function to mask out clouds and cloud shadows.
function fmask(img) {
  var cloudShadowBitMask = 1 << 3;
  var cloudsBitMask = 1 << 5;
  var qa = img.select('pixel_qa');
  var mask = qa.bitwiseAnd(cloudShadowBitMask).eq(0)
    .and(qa.bitwiseAnd(cloudsBitMask).eq(0));
  return img.updateMask(mask);
}

// Define function to calculate NBR.
function calcNBR(img) {
  return img.normalizedDifference(['B5', 'B7']).rename('NBR');
}

// Define wrapper function to prepare images using above functions.
function prepImg(img) {
  var orig = img;
  img = oliBands(img);
  img = fmask(img);
  img = etm2oli(img);
  img = calcNBR(img);
  return ee.Image(img.copyProperties(orig, orig.propertyNames()));
}

// ################################################################
// ### APPLICATION ###
// ################################################################

// Define a point on the north slope of Mount Hood, OR
// to extract time series for.
var point = ee.Geometry.Point([-121.70938, 45.43185]);

// Get Landsat surface reflectance collections for OLI, ETM+ and TM sensors.
var oliCol = ee.ImageCollection('LANDSAT/LC08/C01/T1_SR');
var etmCol= ee.ImageCollection('LANDSAT/LE07/C01/T1_SR');
var tmCol= ee.ImageCollection('LANDSAT/LT05/C01/T1_SR');

// Define a collection filter.
var colFilter = ee.Filter.and(
  ee.Filter.bounds(point),
  ee.Filter.calendarRange(182, 244, 'day_of_year'),
  ee.Filter.lt('CLOUD_COVER', 50),
  ee.Filter.lt('GEOMETRIC_RMSE_MODEL', 10),
  ee.Filter.or(
    ee.Filter.eq('IMAGE_QUALITY', 9),
    ee.Filter.eq('IMAGE_QUALITY_OLI', 9)
  )
);

// Merge collections, apply filter, and prepare images.
var col = oliCol
  .merge(etmCol)
  .merge(tmCol)
  .filter(colFilter)
  .map(prepImg);

// Extract NBR values for all pixels in the collection that
// intersect the point. Returns FeatureCollection - copy image
// properties to each feature.
var allObs = col.map(function(img) {
  return ee.Feature(null, img.reduceRegion({
    geometry: point,
    reducer: ee.Reducer.first(),
    scale: 30
  })).copyProperties(img, img.propertyNames());
});

// Make a chart of all observations in FeatureCollection.
var chartAllObs = ui.Chart.feature.groups(
  allObs, 'system:time_start', 'NBR', 'SATELLITE'
)
.setChartType('ScatterChart')
.setSeriesNames(['TM', 'ETM+', 'OLI'])
.setOptions({
  title: 'All Observations',
  colors: ['f8766d', '00ba38', '619cff'],
  hAxis: {title: 'Date'},
  vAxis: {title: 'NBR'},
  pointSize: 6,
  dataOpacity: 0.5
});
print(chartAllObs);

// Reduce the ImageCollection to intra-annual median.
// Need to identify same-year images by a join.
// Start by adding a 'year' property to each image.
var col = col.map(function(img) {
  return img.set('year', img.date().get('year')); 
});

// Subset collection to a set of distinct year representatives.
var distinctYearCol = col.distinct('year');

// Define a filter that identifies images from the complete 
// collection that match the 'year' from the distinct year collection. 
var filter = ee.Filter.equals({leftField: 'year', rightField: 'year'});

// Define a join.
var join = ee.Join.saveAll('year_matches');

// Apply the join and convert the resulting FeatureCollection to an ImageCollection.
var joinCol = ee.ImageCollection(join.apply(distinctYearCol, col, filter));

// Apply median reduction among matching year collections.
var medianComp = joinCol.map(function(img) {
  var yearCol = ee.ImageCollection.fromImages(
    img.get('year_matches')
  );
  return yearCol.reduce(ee.Reducer.median())
    .set('system:time_start', img.date().update({month:8, day:1}));
});

// Make a chart that displays the annual median NBR composite.
var chartMedianComp = ui.Chart.image.series({
  imageCollection: medianComp,
  region: point,
  reducer: ee.Reducer.first(),
  scale: 30,
  xProperty: 'system:time_start',
})
.setSeriesNames(['NBR Median'])
.setOptions({
  title: 'Intra-annual Median',
  colors: ['619cff'],
  hAxis: {title: 'Date'},
  vAxis: {title: 'NBR'},
  lineWidth: 6
});
print(chartMedianComp);

// ################################################################
// ### ALTERNATIVE TRANSFORMATION FUNCTIONS ###
// ################################################################

// Roy et al. (2016) Table 2 provides OLS and RMA regression coefficients
// to translate ETM+ surface reflectance to OLI surface reflectance and vice
// versa. The above tutorial demonstrates only ETM+ to OLI transformation by OLS
// regression. Below are functions for all translation options. Replace above
// lines: 67 (band name standardization) and 69 (transformation) of the `prepImg`
// function to apply different transformation options.

// Define OLS and RMA surface regression coefficients.
var coefficients = {
  etm2oli_ols: {
    itcps: ee.Image.constant([0.0003, 0.0088, 0.0061, 0.0412, 0.0254, 0.0172]).multiply(10000),
    slopes: ee.Image.constant([0.8474, 0.8483, 0.9047, 0.8462, 0.8937, 0.9071])
  },
  oli2etm_ols: {
    itcps: ee.Image.constant([0.0183, 0.0123, 0.0123, 0.0448, 0.0306, 0.0116]).multiply(10000),
    slopes: ee.Image.constant([0.885, 0.9317, 0.9372, 0.8339, 0.8639, 0.9165])
  },
  rma: {
    itcps: ee.Image.constant([-0.0095, -0.0016, -0.0022, -0.0021, -0.0030, 0.0029]).multiply(10000),
    slopes: ee.Image.constant([0.9785, 0.9542, 0.9825, 1.0073, 1.0171, 0.9949])
  }
};

// Define function to apply OLS ETM+ to OLI transformation.
function etm2oli_ols(img) {
  return img.select(['B2', 'B3', 'B4', 'B5', 'B6', 'B7'])
    .multiply(coefficients.etm2oli_ols.slopes)
    .add(coefficients.etm2oli_ols.itcps)
    .round()
    .toShort()
    .addBands(img.select('pixel_qa')
  );
}

// Define function to apply OLS OLI to ETM+ transformation.
function oli2etm_ols(img) {
  return ee.Image(
    img.select(['B1', 'B2', 'B3', 'B4', 'B5', 'B7'])
      .multiply(coefficients.oli2etm_ols.slopes)
      .add(coefficients.oli2etm_ols.itcps)
      .round()
      .toShort()
      .addBands(img.select('pixel_qa'))
      .copyProperties(img, ['system:time_start'])
  );
}

// Define function to apply RMA OLI to ETM+ transformation.
function oli2etm_rma(img) {
  return ee.Image(
    img.select(['B1', 'B2', 'B3', 'B4', 'B5', 'B7'])
      .subtract(coefficients.rma.itcps)
      .divide(coefficients.rma.slopes)
      .round()
      .toShort()
      .addBands(img.select('pixel_qa'))
      .copyProperties(img, ['system:time_start'])
  );
}

// Define function to apply RMA ETM+ to OLI transformation.
function etm2oli_rma(img) {
  return ee.Image(
    img.select(['B2', 'B3', 'B4', 'B5', 'B6', 'B7'])
      .multiply(coefficients.rma.slopes)
      .add(coefficients.rma.itcps)
      .round()
      .toShort()
      .addBands(img.select('pixel_qa'))
      .copyProperties(img, ['system:time_start'])
  );
}

// Define function to get consistent band names (OLI).
function oliBands(img) {
  return ee.Image(ee.Algorithms.If(
    ee.Algorithms.IsEqual(img.get('SATELLITE'), ee.String('LANDSAT_8')),
    img.select(['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'pixel_qa']),
    img.select(['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'pixel_qa'], ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'pixel_qa'])
  ));
}

// Define function to get consistent band names (ETM+).
function etmBands(img) {
  return ee.Image(ee.Algorithms.If(
    ee.Algorithms.IsEqual(img.get('SATELLITE'), ee.String('LANDSAT_8')),
    img.select(['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'pixel_qa'], ['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'pixel_qa']),
    img.select(['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'pixel_qa'])
  ));
}
