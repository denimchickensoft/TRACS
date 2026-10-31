-- Registers TRACS with DCS's module list. The exporter itself is
-- Scripts/Hooks/TRACS-Exporter.lua, which loads bin/tracs_exporter.dll.
declare_plugin('TRACS', {
  installed        = true,
  dirName          = current_mod_path,
  binaries         = {},
  load_immediately = true,

  displayName      = 'TRACS',
  shortName        = 'TRACS',
  fileMenuName     = 'TRACS',

  state            = 'installed',
  developerName    = 'TRACS',
  info             = _('TRACS exporter: sends mission data from DCS to a TRACS Relay on this machine.'),
})

plugin_done()
