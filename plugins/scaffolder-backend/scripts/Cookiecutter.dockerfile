FROM alpine:3.16.9

RUN apk add --update \
	git \
	python \
	python-dev \
	py-pip \
	g++ && \
	pip install cookiecutter && \
	apk del g++ py-pip python-dev && \
	rm -rf /var/cache/apk/* 
