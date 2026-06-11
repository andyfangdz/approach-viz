import SwiftUI

struct NativeDebugPanel: View {
    let renderStats: ApproachMetalRenderStats
    let onClose: () -> Void

    var body: some View {
        NativePanelContainer(title: "Debug", onClose: onClose) {
            VStack(alignment: .leading, spacing: 6) {
                DebugStatRow(label: "Invalidated", value: renderStats.invalidationSummary)
                DebugStatRow(label: "Draw", value: String(format: "%.2f ms", renderStats.drawCPUms))
                DebugStatRow(label: "Sync", value: String(format: "%.2f ms", renderStats.syncCPUms))
                DebugStatRow(label: "Upload", value: String(format: "%.2f ms", renderStats.uploadCPUms))
                DebugStatRow(label: "Labels", value: String(format: "%.2f ms", renderStats.labelCPUms))
                DebugStatRow(label: "Calls", value: "\(renderStats.drawCallCount)")
                DebugStatRow(label: "Triangles", value: "\(renderStats.triangleCount)")
                DebugStatRow(label: "Lines", value: "\(renderStats.lineCount)")
                DebugStatRow(label: "Points", value: "\(renderStats.pointCount)")
                DebugStatRow(label: "Labels Visible", value: "\(renderStats.labelCount)")
            }
            .font(.system(.caption, design: .monospaced))
        }
    }
}

private struct DebugStatRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .foregroundStyle(.white.opacity(0.6))
            Spacer()
            Text(value)
                .foregroundStyle(.white.opacity(0.92))
        }
    }
}
