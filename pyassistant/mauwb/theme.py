"""Chart tokens for the live viewer.

The categorical slots are assigned in fixed order and never cycled: tag #5 falls
into the muted "other" slot rather than reusing tag #1's colour. Every tag marker
is also direct-labelled with its short address, so identity never rests on colour
alone -- which is what relieves the sub-3:1 contrast of the aqua slot.

The four-slot order below was validated against the light chart surface on the
all-pairs list (scatter-type form): lightness band, chroma floor, CVD separation
(worst dE 9.2 deutan), and normal-vision floor (worst dE 16.3) all pass.
"""

SURFACE = "#fcfcfb"       # chart surface
PLANE = "#f9f9f7"         # page plane behind the axes
INK = "#0b0b0b"           # primary ink
INK_2 = "#52514e"         # secondary ink
MUTED = "#898781"         # axis and tick labels
GRID = "#e1e0d9"          # hairline gridline
AXIS = "#c3c2b7"          # baseline / axis

#: Fixed categorical order. Index 4+ folds into OTHER.
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#4a3aa7"]
OTHER = "#898781"

#: Reserved status colours -- never reused as a series colour.
STATUS = {
    "good": "#0ca30c",
    "warning": "#fab219",
    "serious": "#ec835a",
    "critical": "#d03b3b",
}

FONT = ["system-ui", "DejaVu Sans", "Segoe UI", "sans-serif"]


def series_color(slot: int) -> str:
    """Colour for categorical slot ``slot`` (0-based), folding past slot 4."""
    return SERIES[slot] if 0 <= slot < len(SERIES) else OTHER


def apply(plt) -> None:
    """Push the tokens into matplotlib rcParams."""
    plt.rcParams.update({
        "figure.facecolor": PLANE,
        "axes.facecolor": SURFACE,
        "savefig.facecolor": PLANE,
        "axes.edgecolor": AXIS,
        "axes.labelcolor": INK_2,
        "axes.titlecolor": INK,
        "axes.grid": True,
        "axes.axisbelow": True,
        "grid.color": GRID,
        "grid.linewidth": 0.8,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "xtick.labelcolor": MUTED,
        "ytick.labelcolor": MUTED,
        "text.color": INK,
        "font.family": "sans-serif",
        "font.sans-serif": FONT,
        "font.size": 9,
        "axes.titlesize": 10,
        "axes.titleweight": "600",
        "legend.frameon": False,
        "lines.linewidth": 2.0,
        "lines.markersize": 8,
    })
