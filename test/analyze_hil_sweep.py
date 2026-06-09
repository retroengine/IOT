import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
import os
import sys

# Constants and Configuration
script_dir = os.path.dirname(os.path.abspath(__file__))
csv_file = os.path.join(script_dir, "certification_data.csv")
output_png = os.path.join(script_dir, 'hil_certification_chart.png')

# 1. Safeback Ingestion Logic
if not os.path.exists(csv_file):
    print(f"[!] FATAL: '{csv_file}' not found.")
    print("    You must execute PowerShell: .\\hil_orchestrator.ps1 to generate the telemetry payload first.")
    sys.exit(1)

print("[+] Ingesting High-Density HIL Telemetry Data...")
df = pd.read_csv(csv_file)

if df.empty:
    print("[!] FATAL: CSV is completely empty. Run the PowerShell sweep properly.")
    sys.exit(1)

# Sorting by Category for logical grouping on the X-axis
df = df.sort_values(by=['Category', 'TestID']).reset_index(drop=True)

# 2. Advanced Aesthetics & Mapping
print("[+] Processing Multi-Dimensional Storytelling Visualization...")

# Premium Color Palette for Categories
cat_colors = {
    'VOLTAGE': '#3498db',        # Bright Blue
    'NOISE_IMMUNITY': '#95a5a6', # Concrete Gray
    'IDMT': '#9b59b6',           # Amethyst Purple
    'SHORT_CIRCUIT': '#e74c3c',  # Alizarin Red
    'MOTOR_INRUSH': '#f1c40f',   # Sunflower Yellow
    'BOUNDARY': '#1abc9c'        # Turquoise Teal
}

# 3. Figure Initialization
plt.style.use('bmh')
fig, ax = plt.subplots(figsize=(20, 11))

# 4. Success/Stability Zone Shading
# Green zone for stability (expected 1200ms duration)
ax.fill_between([-1, len(df)], 500, 70000, color='#2ecc71', alpha=0.05, label='Target Stability Region (No Trip)')
# Green zone for instant response (expected < 100ms)
ax.fill_between([-1, len(df)], 0, 100, color='#2ecc71', alpha=0.08, label='Target Response Region (Instant Trip)')

# 5. Data Layer Preparation (Splitting the Story)
# Circle (o) = Reaction Test (Goal: Low time)
# Triangle (^) = Stability Test (Goal: High duration/No Trip)

for cat, group in df.groupby('Category', sort=False):
    color = cat_colors.get(cat, '#34495e')
    
    # TRIP tests (Reaction)
    trip_mask = (group['ExpectedResult'] == 'TRIP') & (group['Result'] == 'PASS')
    ax.scatter(group.index[trip_mask], group.loc[trip_mask, 'SimTime_ms'], 
               color=color, label=f"{cat} (Reaction)", s=130, marker='o', 
               edgecolors='black', alpha=0.8, zorder=4)
    
    # NO TRIP tests (Stability)
    stable_mask = (group['ExpectedResult'] == 'NO_TRIP') & (group['Result'] == 'PASS')
    ax.scatter(group.index[stable_mask], group.loc[stable_mask, 'SimTime_ms'], 
               color=color, label=f"{cat} (Stability)", s=150, marker='^', 
               edgecolors='black', alpha=0.8, zorder=4)
    
    # FAILURES (Highlight regardless of type)
    fail_mask = group['Result'] == 'FAIL'
    if fail_mask.any():
        ax.scatter(group.index[fail_mask], group.loc[fail_mask, 'SimTime_ms'], 
                   color='white', label=f"{cat} (FAILURE)", s=250, edgecolors='red', 
                   linewidth=3, marker='X', zorder=10)

# 6. Scaling Strategy (Logarithmic)
ax.set_yscale('log')
ax.yaxis.set_major_formatter(ticker.FuncFormatter(lambda y, _: f'{int(y)}ms'))
ax.set_ylim(10, 80000)

# 7. Safety Boundary Line (Critical for Instant Trips)
ax.axhline(100, color='#c0392b', linestyle='--', linewidth=2.5, alpha=0.7, 
           label='Reaction Limit (100ms)', zorder=2)

# 8. Decluttering & Failure Highlighting
n = 15 # Stride
visible_tick_indices = list(range(0, len(df), n))

# Force labels for failing tests
fail_indices = df.index[df['Result'] == 'FAIL'].tolist()
for fi in fail_indices:
    if fi not in visible_tick_indices:
        visible_tick_indices.append(fi)

visible_tick_indices.sort()
visible_labels = [df['TestID'][i] for i in visible_tick_indices]

ax.set_xticks(visible_tick_indices)
ax.set_xticklabels(visible_labels, rotation=45, ha='right', fontsize=9)

# 9. Smart Annotations
# Annotate only failures or specific high-latency IDMT inflection points
for i, row in df.iterrows():
    if row['Result'] == 'FAIL' or (row['SimTime_ms'] > 10000 and row['Category'] == 'IDMT'):
        label = f"{row['Result']}: {int(row['SimTime_ms'])}ms"
        ax.annotate(label, (i, row['SimTime_ms']), 
                    xytext=(0, 15), textcoords='offset points', 
                    ha='center', fontsize=9, fontweight='bold', color='darkred',
                    bbox=dict(boxstyle='round,pad=0.2', fc='white', ec='red', alpha=0.7))

# 10. Meta-data & Branding
ax.set_title('Smart Grid Sentinel : HIL Certification Map (Reaction vs Stability)', fontsize=24, fontweight='bold', pad=25)
ax.set_ylabel('Interaction Metric (Response / Stability Duration)', fontsize=15, fontweight='semibold')
ax.set_xlabel('HIL Test Sequence (Grouped by Category)', fontsize=15, fontweight='semibold')

# Background Grid
ax.grid(True, which="both", ls="-", alpha=0.1, zorder=0)

# Multi-column legend for better space usage
ax.legend(loc='upper right', bbox_to_anchor=(1.22, 1), frameon=True, fontsize=10, ncol=1)
plt.tight_layout()

# 11. Save and Export
plt.savefig(output_png, dpi=300, bbox_inches='tight')

print(f"\n==========================================")
print(f" [PASS] Dynamic Storytelling Generation Complete.")
print(f" [FILE] Enhanced Analytical Chart saved to: {output_png}")
print(f"==========================================")
