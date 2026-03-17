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

struct RasterVertex {
    float4 position [[position]];
    float4 color;
};

struct RasterPointVertex {
    float4 position [[position]];
    float4 color;
    float pointSize [[point_size]];
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
