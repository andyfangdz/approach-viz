#include <metal_stdlib>
using namespace metal;

struct MetalVertex {
    float3 position;
    float4 color;
};

struct MetalPointVertex {
    float3 position;
    float4 color;
    float size;
};

struct MetalUniforms {
    float4x4 viewProjectionMatrix;
};

struct MetalTextVertex {
    float2 position;
    float2 texCoord;
    float4 color;
};

struct RasterVertex {
    float4 position [[position]];
    float4 color;
};

struct RasterPointVertex {
    float4 position [[position]];
    float4 color;
    float pointSize [[point_size]];
};

struct RasterTextVertex {
    float4 position [[position]];
    float2 texCoord;
    float4 color;
};

vertex RasterVertex basicVertex(
    const device MetalVertex *vertices [[buffer(0)]],
    constant MetalUniforms &uniforms [[buffer(1)]],
    uint vid [[vertex_id]]
) {
    RasterVertex out;
    out.position = uniforms.viewProjectionMatrix * float4(vertices[vid].position, 1.0);
    out.color = vertices[vid].color;
    return out;
}

fragment float4 basicFragment(RasterVertex in [[stage_in]]) {
    return in.color;
}

vertex RasterPointVertex pointVertex(
    const device MetalPointVertex *vertices [[buffer(0)]],
    constant MetalUniforms &uniforms [[buffer(1)]],
    uint vid [[vertex_id]]
) {
    RasterPointVertex out;
    out.position = uniforms.viewProjectionMatrix * float4(vertices[vid].position, 1.0);
    out.color = vertices[vid].color;
    out.pointSize = vertices[vid].size;
    return out;
}

fragment float4 pointFragment(RasterPointVertex in [[stage_in]], float2 pointCoord [[point_coord]]) {
    float2 centered = pointCoord * 2.0 - 1.0;
    if (dot(centered, centered) > 1.0) {
        discard_fragment();
    }
    return in.color;
}

vertex RasterTextVertex textVertex(
    const device MetalTextVertex *vertices [[buffer(0)]],
    uint vid [[vertex_id]]
) {
    RasterTextVertex out;
    out.position = float4(vertices[vid].position, 0.0, 1.0);
    out.texCoord = vertices[vid].texCoord;
    out.color = vertices[vid].color;
    return out;
}

fragment float4 textFragment(
    RasterTextVertex in [[stage_in]],
    texture2d<float> atlasTexture [[texture(0)]],
    sampler atlasSampler [[sampler(0)]]
) {
    float distance = atlasTexture.sample(atlasSampler, in.texCoord).r;
    float smoothing = max(fwidth(distance), 1.0 / 64.0);
    float alpha = smoothstep(0.5 - smoothing, 0.5 + smoothing, distance);
    if (alpha <= 0.001) {
        discard_fragment();
    }
    return float4(in.color.rgb, in.color.a * alpha);
}
