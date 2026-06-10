import ComposableArchitecture
import SwiftUI

struct DetailControlPanelOverlay: View {
    let store: StoreOf<AppFeature>
    @Binding var renderStats: ApproachMetalRenderStats

    var body: some View {
        GeometryReader { proxy in
            VStack {
                Spacer(minLength: 0)
                if let panel = store.activePanel {
                    DetailControlPanelSheet(
                        maxHeight: min(560, proxy.size.height * 0.58),
                    ) {
                        panelContent(for: panel)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .animation(.spring(response: 0.28, dampingFraction: 0.9), value: store.activePanel)
        }
    }

    @ViewBuilder
    private func panelContent(for panel: DetailControlPanel) -> some View {
        switch panel {
        case .selectors:
            NativeSelectorPanel(store: store) {
                store.send(.setActivePanel(nil))
            }
        case .layers:
            NativeLayersPanel(store: store) {
                store.send(.setActivePanel(nil))
            }
        case .options:
            NativeOptionsPanel(store: store) {
                store.send(.setActivePanel(nil))
            }
        case .debug:
            NativeDebugPanel(renderStats: renderStats) {
                store.send(.setActivePanel(nil))
            }
        }
    }
}

private struct DetailControlPanelSheet<Content: View>: View {
    let maxHeight: CGFloat
    let content: Content

    init(maxHeight: CGFloat, @ViewBuilder content: () -> Content) {
        self.maxHeight = maxHeight
        self.content = content()
    }

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Color.white.opacity(0.22))
                .frame(width: 44, height: 5)
                .padding(.top, 10)
                .padding(.bottom, 8)
            ScrollView {
                content
            }
            .scrollIndicators(.hidden)
        }
        .frame(maxWidth: .infinity)
        .frame(maxHeight: maxHeight, alignment: .top)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(Color.white.opacity(0.06))
        )
        .shadow(color: .black.opacity(0.24), radius: 22, y: 10)
    }
}

struct FloatingFabButton: View {
    let systemImage: String
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 52, height: 52)
                .background(.ultraThinMaterial, in: Circle())
        }
        .buttonStyle(.plain)
        .platformPointerButton()
        .foregroundStyle(.white)
        .help(title)
        .accessibilityLabel(title)
    }
}

struct NativePanelContainer<Content: View>: View {
    let title: String
    let onClose: () -> Void
    let content: Content

    init(title: String, onClose: @escaping () -> Void, @ViewBuilder content: () -> Content) {
        self.title = title
        self.onClose = onClose
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title)
                    .font(.headline)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white.opacity(0.85))
                        .frame(width: 28, height: 28)
                        .background(Color.white.opacity(0.08), in: Circle())
                }
                .buttonStyle(.plain)
                .platformPointerButton()
            }
            content
        }
        .padding(.horizontal, 18)
        .padding(.top, 18)
        .padding(.bottom, 28)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
