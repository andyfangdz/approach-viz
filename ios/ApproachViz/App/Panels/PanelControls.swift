import SwiftUI

#if os(macOS)
import AppKit
#endif

struct LayerToggleRow: View {
    let title: String
    let isOn: Binding<Bool>
    var disabled = false

    var body: some View {
        Toggle(isOn: isOn) {
            Text(title)
                .font(.subheadline)
        }
        .toggleStyle(.switch)
        .disabled(disabled)
        .foregroundStyle(disabled ? .white.opacity(0.35) : .white.opacity(0.92))
    }
}

struct SectionLabel: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.caption.weight(.bold))
            .foregroundStyle(.white.opacity(0.58))
            .textCase(.uppercase)
    }
}

private struct PlatformPointerButtonModifier: ViewModifier {
    func body(content: Content) -> some View {
        #if os(macOS)
        content.onHover { hovering in
            if hovering {
                NSCursor.pointingHand.set()
            } else {
                NSCursor.arrow.set()
            }
        }
        #else
        content
        #endif
    }
}

extension View {
    func platformPointerButton() -> some View {
        modifier(PlatformPointerButtonModifier())
    }
}
