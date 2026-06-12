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

struct MetalVoxelInstance {
    float3 center;
    float3 halfExtent;
    float4 color;
};

struct MetalVoxelShadeParams {
    float densityScale;
    float softCap;
    float materialOpacity;
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

struct RasterVoxelVertex {
    float4 position [[position]];
    float4 color;
    float3 localPos;
};

// Unit cube corner signs (±1) expanded into 12 triangles, matching the
// face/winding layout used by the CPU-side box builders.
constant float3 voxelCubeCorners[8] = {
    float3(-1.0, -1.0, -1.0),
    float3( 1.0, -1.0, -1.0),
    float3( 1.0,  1.0, -1.0),
    float3(-1.0,  1.0, -1.0),
    float3(-1.0, -1.0,  1.0),
    float3( 1.0, -1.0,  1.0),
    float3( 1.0,  1.0,  1.0),
    float3(-1.0,  1.0,  1.0),
};

constant ushort voxelCubeIndices[36] = {
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
};

vertex RasterVoxelVertex voxelVertex(
    const device MetalVoxelInstance *instances [[buffer(0)]],
    constant MetalUniforms &uniforms [[buffer(1)]],
    uint vid [[vertex_id]],
    uint iid [[instance_id]]
) {
    const MetalVoxelInstance instance = instances[iid];
    const float3 corner = voxelCubeCorners[voxelCubeIndices[vid]];
    RasterVoxelVertex out;
    out.position = uniforms.viewProjectionMatrix
        * float4(instance.center + corner * instance.halfExtent, 1.0);
    out.color = instance.color;
    out.localPos = corner;
    return out;
}

// Port of the web MRMS material patch (nexrad-render.ts
// `patchMaterialForInstanceAlpha`): soft edge falloff, vertical glow, and
// Beer-Lambert transmittance with a soft cap. The instance alpha carries the
// dBZ intensity ramp; the per-pass density/cap/opacity constants come in as
// shade params so the same voxel buffer draws both the base and glow passes.
fragment float4 voxelFragment(
    RasterVoxelVertex in [[stage_in]],
    constant MetalVoxelShadeParams &shade [[buffer(0)]]
) {
    float3 normalizedPos = abs(in.localPos);
    float radial = length(normalizedPos);
    float edgeSoftness = 1.0 - smoothstep(1.18, 1.73, radial);
    float verticalGlow = 0.75 + 0.25 * (1.0 - normalizedPos.y);
    float shapedAlpha = max(0.05, edgeSoftness * verticalGlow);
    float opticalDepth = max(0.0, in.color.a * shapedAlpha * shade.densityScale);
    float transmittanceAlpha = 1.0 - exp(-opticalDepth);
    float softCapAlpha = 1.0 - exp(-transmittanceAlpha * shade.softCap);
    return float4(in.color.rgb, shade.materialOpacity * softCapAlpha);
}

// Flat-shaded instanced boxes (echo-top threshold surfaces): the instance
// color carries the final alpha, matching the web's plain translucent
// MeshBasicMaterial per threshold.
fragment float4 voxelFlatFragment(RasterVoxelVertex in [[stage_in]]) {
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
