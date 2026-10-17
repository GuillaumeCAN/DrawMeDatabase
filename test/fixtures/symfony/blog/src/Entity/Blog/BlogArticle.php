<?php

namespace App\Entity\Blog;

use App\Entity\User;
use Doctrine\ORM\Mapping\Column;
use Doctrine\ORM\Mapping\Entity;
use Doctrine\ORM\Mapping\GeneratedValue;
use Doctrine\ORM\Mapping\JoinColumn;
use Doctrine\ORM\Mapping\ManyToOne;

#[Entity]
class BlogArticle
{
    #[\Doctrine\ORM\Mapping\Id, GeneratedValue, Column]
    private ?int $id = null;

    #[Column(name: 'headline_text', length: 255)]
    private ?string $headline = null;

    #[Column(nullable: true)]
    private ?int $top10Rank = null;

    #[ManyToOne(targetEntity: User::class)]
    #[JoinColumn(name: 'writer_ref')]
    private ?User $writer = null;
}
