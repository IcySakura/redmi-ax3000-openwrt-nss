include $(TOPDIR)/rules.mk

PKG_NAME:=ra81-ota
PKG_VERSION:=2
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only
PKG_MAINTAINER:=Myles Liu <lyx981mike@gmail.com>

include $(INCLUDE_DIR)/package.mk

define Package/ra81-ota
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Signed A/B firmware updates from GitHub releases (Redmi AX3000 RA81)
  DEPENDS:=@TARGET_qualcommax_ipq50xx_DEVICE_xiaomi_redmi-ax3000 \
	+uclient-fetch +libustream-mbedtls +ca-bundle +usign +jsonfilter +ucode +ucode-mod-fs
  PKGARCH:=all
endef

define Package/ra81-ota/description
  Looks up the newest GitHub release of the repository that built the
  image, verifies its usign-signed checksums and flashes it into the
  other dual-boot slot. The new firmware's first boot is a trial that is
  rolled back unless it is confirmed.
endef

define Package/ra81-ota/conffiles
/etc/config/ra81-ota
endef

define Build/Compile
endef

define Package/ra81-ota/install
	$(INSTALL_DIR) $(1)/usr/sbin $(1)/etc/init.d $(1)/etc/config $(1)/usr/share/ra81-ota $(1)/lib/upgrade/keep.d
	$(INSTALL_BIN) ./files/ra81-ota $(1)/usr/sbin/ra81-ota
	$(INSTALL_BIN) ./files/ra81-ota.init $(1)/etc/init.d/ra81-ota
	$(INSTALL_CONF) ./files/ra81-ota.config $(1)/etc/config/ra81-ota
	$(INSTALL_DATA) ./files/details.uc $(1)/usr/share/ra81-ota/details.uc
	$(INSTALL_DATA) ./files/ra81-ota.keep $(1)/lib/upgrade/keep.d/ra81-ota
endef

$(eval $(call BuildPackage,ra81-ota))
