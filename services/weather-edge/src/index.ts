import wasmModule from '../pkg/approach_viz_weather_edge_bg.wasm';
import { initSync } from '../pkg/approach_viz_weather_edge.js';
import { handleRequest, type WeatherEnv } from './weather.ts';

initSync({ module: wasmModule });

interface Env extends WeatherEnv {
  WEATHER_BUCKET: R2Bucket;
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
