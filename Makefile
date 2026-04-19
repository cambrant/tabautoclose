.PHONY: build clean

build: tabautoclose.xpi

tabautoclose.xpi: manifest.json background.js options.html options.js icon.png
	zip -r $@ $^

clean:
	rm -f tabautoclose.xpi
