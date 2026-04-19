.PHONY: build clean test

build: tabautoclose.xpi

tabautoclose.xpi: manifest.json background.js options.html options.js icon.png
	zip -r $@ $^

test:
	node --test tests/*.test.js

clean:
	rm -f tabautoclose.xpi
