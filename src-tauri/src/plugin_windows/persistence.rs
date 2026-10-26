//! Host-owned presentation only. No renderer bundle, token or business state.
use super::*;
use rusqlite::{params, OptionalExtension};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Presentation {
    Docked,
    Detached,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    pub presentation: Presentation,
    pub was_open: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Geometry {
    pub normal: Bounds,
    pub maximized: bool,
    pub monitor: Option<String>,
    pub dpi: f64,
}
fn schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS plugin_window_presentation (
        plugin_id TEXT NOT NULL, tab_id TEXT NOT NULL, intent TEXT, geometry TEXT,
        PRIMARY KEY(plugin_id, tab_id));",
    )
    .map_err(|e| e.to_string())
}
fn read<T: serde::de::DeserializeOwned>(
    db: &crate::db::Db,
    plugin: &str,
    tab: &str,
    geometry: bool,
) -> Result<Option<T>, String> {
    let conn = db.0.lock();
    schema(&conn)?;
    let query = if geometry {
        "SELECT geometry FROM plugin_window_presentation WHERE plugin_id=?1 AND tab_id=?2"
    } else {
        "SELECT intent FROM plugin_window_presentation WHERE plugin_id=?1 AND tab_id=?2"
    };
    let value: Option<String> = conn
        .query_row(query, params![plugin, tab], |r| {
            r.get::<_, Option<String>>(0)
        })
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    value
        .map(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
        .transpose()
}
pub fn intent(db: &crate::db::Db, plugin: &str, tab: &str) -> Result<Option<Intent>, String> {
    read(db, plugin, tab, false)
}
pub fn geometry(db: &crate::db::Db, plugin: &str, tab: &str) -> Result<Option<Geometry>, String> {
    read(db, plugin, tab, true)
}
fn write<T: Serialize>(
    db: &crate::db::Db,
    plugin: &str,
    tab: &str,
    value: &T,
    geometry: bool,
) -> Result<(), String> {
    let value = serde_json::to_string(value).map_err(|e| e.to_string())?;
    let conn = db.0.lock();
    schema(&conn)?;
    let query = if geometry {
        "INSERT INTO plugin_window_presentation(plugin_id,tab_id,geometry) VALUES(?1,?2,?3) ON CONFLICT(plugin_id,tab_id) DO UPDATE SET geometry=excluded.geometry"
    } else {
        "INSERT INTO plugin_window_presentation(plugin_id,tab_id,intent) VALUES(?1,?2,?3) ON CONFLICT(plugin_id,tab_id) DO UPDATE SET intent=excluded.intent"
    };
    conn.execute(query, params![plugin, tab, value])
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn set_intent(
    db: &crate::db::Db,
    plugin: &str,
    tab: &str,
    value: &Intent,
) -> Result<(), String> {
    write(db, plugin, tab, value, false)
}
pub fn set_geometry(
    db: &crate::db::Db,
    plugin: &str,
    tab: &str,
    value: &Geometry,
) -> Result<(), String> {
    write(db, plugin, tab, value, true)
}

/// Physical outer bounds, scaled to the chosen display and clamped to its work area.
pub fn fit(normal: &Bounds, old_dpi: f64, dpi: f64, work: &Bounds) -> Bounds {
    let ratio = if old_dpi.is_finite() && old_dpi > 0.0 && dpi.is_finite() && dpi > 0.0 {
        dpi / old_dpi
    } else {
        1.0
    };
    let width = ((normal.width as f64 * ratio).round() as u32)
        .max(1)
        .min(work.width.max(1));
    let height = ((normal.height as f64 * ratio).round() as u32)
        .max(1)
        .min(work.height.max(1));
    Bounds {
        x: (normal.x as i64).clamp(
            work.x as i64,
            work.x as i64 + work.width.saturating_sub(width) as i64,
        ) as i32,
        y: (normal.y as i64).clamp(
            work.y as i64,
            work.y as i64 + work.height.saturating_sub(height) as i64,
        ) as i32,
        width,
        height,
    }
}

pub fn initial_bounds(work: &Bounds, dpi: f64) -> Bounds {
    let scale = if dpi.is_finite() && dpi > 0.0 {
        dpi
    } else {
        1.0
    };
    let width = ((work.width as f64 * 0.9).min(1440.0 * scale).floor() as u32).max(1);
    let height = ((work.height as f64 * 0.9).min(900.0 * scale).floor() as u32).max(1);
    Bounds {
        x: (work.x as i64 + work.width.saturating_sub(width) as i64 / 2) as i32,
        y: (work.y as i64 + work.height.saturating_sub(height) as i64 / 2) as i32,
        width,
        height,
    }
}
pub fn initial(window: &WebviewWindow) -> Result<Geometry, String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("plugin_window_monitor_unavailable")?;
    let area = monitor.work_area();
    let work = Bounds {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    };
    Ok(Geometry {
        normal: initial_bounds(&work, monitor.scale_factor()),
        maximized: false,
        monitor: monitor.name().cloned(),
        dpi: monitor.scale_factor(),
    })
}

pub fn sample(
    app: &AppHandle,
    window: &WebviewWindow,
    plugin: &str,
    tab: &str,
) -> Result<Option<Geometry>, String> {
    if window.is_minimized().map_err(|e| e.to_string())? {
        return Ok(None);
    }
    let db = app.state::<std::sync::Arc<crate::db::Db>>();
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    let previous = geometry(&db, plugin, tab)?;
    // Maximization never overwrites the last normal rectangle or its DPI.
    let geometry = if maximized {
        let Some(mut previous) = previous else {
            return Ok(None);
        };
        previous.maximized = true;
        previous
    } else {
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        Geometry {
            normal: Bounds {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            },
            maximized: false,
            monitor: window
                .current_monitor()
                .map_err(|e| e.to_string())?
                .and_then(|m| m.name().cloned()),
            dpi: window.scale_factor().map_err(|e| e.to_string())?,
        }
    };
    Ok(Some(geometry))
}
pub fn capture(
    app: &AppHandle,
    window: &WebviewWindow,
    plugin: &str,
    tab: &str,
) -> Result<(), String> {
    if let Some(geometry) = sample(app, window, plugin, tab)? {
        set_geometry(
            &app.state::<std::sync::Arc<crate::db::Db>>(),
            plugin,
            tab,
            &geometry,
        )?;
    }
    Ok(())
}
pub fn restore(window: &WebviewWindow, saved: &Geometry) -> Result<Geometry, String> {
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let primary = window.primary_monitor().map_err(|e| e.to_string())?;
    let monitor = monitors
        .iter()
        .find(|m| saved.monitor.is_some() && m.name() == saved.monitor.as_ref())
        .or(primary.as_ref())
        .or(monitors.first())
        .ok_or("plugin_window_monitor_unavailable")?;
    let area = monitor.work_area();
    let work = Bounds {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    };
    let bounds = fit(&saved.normal, saved.dpi, monitor.scale_factor(), &work);
    // Move first so border measurements use the destination monitor's DPI.
    window
        .set_position(tauri::PhysicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    // The platform API sizes the client area; persistence stores the whole frame.
    window
        .set_min_size(None::<tauri::PhysicalSize<u32>>)
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(
            bounds
                .width
                .saturating_sub(outer.width.saturating_sub(inner.width))
                .max(1),
            bounds
                .height
                .saturating_sub(outer.height.saturating_sub(inner.height))
                .max(1),
        ))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    window
        .set_min_size(Some(tauri::PhysicalSize::new(
            ((420.0 * monitor.scale_factor()) as u32).min(
                bounds
                    .width
                    .saturating_sub(outer.width.saturating_sub(inner.width))
                    .max(1),
            ),
            ((320.0 * monitor.scale_factor()) as u32).min(
                bounds
                    .height
                    .saturating_sub(outer.height.saturating_sub(inner.height))
                    .max(1),
            ),
        )))
        .map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    Ok(Geometry {
        normal: Bounds {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
        },
        maximized: saved.maximized,
        monitor: monitor.name().cloned(),
        dpi: monitor.scale_factor(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_window_fits_small_work_area_and_caps_large_hidpi_logical_size() {
        let small = Bounds {
            x: -400,
            y: 30,
            width: 400,
            height: 300,
        };
        assert_eq!(
            initial_bounds(&small, 1.0),
            Bounds {
                x: -380,
                y: 45,
                width: 360,
                height: 270
            }
        );
        let large = Bounds {
            x: 0,
            y: 0,
            width: 4000,
            height: 3000,
        };
        assert_eq!(
            initial_bounds(&large, 2.0),
            Bounds {
                x: 560,
                y: 600,
                width: 2880,
                height: 1800
            }
        );
    }
    #[test]
    fn stable_key_separates_intent_and_geometry_without_credentials() {
        let db = crate::db::Db::open_in_memory().unwrap();
        let g = Geometry {
            normal: Bounds {
                x: -1200,
                y: 40,
                width: 900,
                height: 700,
            },
            maximized: true,
            monitor: Some("external".into()),
            dpi: 1.5,
        };
        set_geometry(&db, "plugin", "tab", &g).unwrap();
        let i = Intent {
            presentation: Presentation::Detached,
            was_open: false,
        };
        set_intent(&db, "plugin", "tab", &i).unwrap();
        assert_eq!(intent(&db, "plugin", "tab").unwrap(), Some(i));
        assert_eq!(geometry(&db, "plugin", "tab").unwrap(), Some(g));
        assert_eq!(intent(&db, "other", "tab").unwrap(), None);
    }
    #[test]
    fn removed_monitor_and_dpi_change_fit_entire_window_in_work_area() {
        let normal = Bounds {
            x: -3000,
            y: 2000,
            width: 1600,
            height: 1200,
        };
        let area = Bounds {
            x: 100,
            y: 40,
            width: 1000,
            height: 700,
        };
        assert_eq!(fit(&normal, 1.0, 2.0, &area), area);
        assert_eq!(
            fit(&normal, 2.0, 1.0, &area),
            Bounds {
                x: 100,
                y: 140,
                width: 800,
                height: 600
            }
        );
    }
}
